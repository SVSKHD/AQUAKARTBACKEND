import { createHash } from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { BlogToolError } from "./errors.js";
import { sniffImageType } from "../../validators/mcp/blog.js";

// How images reach the MCP server. Two mechanisms, exactly one per call:
//  1. `image`: a ChatGPT file param ({ download_url, file_id, ... }). The
//     server downloads it, but only over HTTPS from MCP_TRUSTED_FILE_HOSTS,
//     only to public IP addresses (checked at connect time, so DNS
//     rebinding can't reach internal hosts), with a size cap and timeout.
//  2. `imageBase64`: the bytes inline in the tool call. Works with every
//     MCP client (Claude, Claude Code, Inspector) but is bounded by what the
//     client can send in one call.
// Arbitrary image URLs are never fetched. The real format is read from the
// bytes; declared MIME types and names are ignored.

const BLOCKED = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
]) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

export const isPublicAddress = (address) => {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address. (A
  // ::ffff:0:0/96 rule can't be used: BlockList applies it to all IPv4.)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(address));
  const value = mapped ? mapped[1] : address;
  const family = net.isIP(value);
  if (!family) return false;
  return !BLOCKED.check(value, family === 6 ? "ipv6" : "ipv4");
};

export const hostAllowed = (hostname, trustedHosts) => {
  const host = String(hostname || "").toLowerCase();
  return trustedHosts.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );
};

// dns.lookup wrapper that refuses private/reserved addresses.
const safeLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses || [];
    if (!list.length || list.some((entry) => !isPublicAddress(entry.address))) {
      return callback(
        Object.assign(new Error("Resolved to a non-public address"), {
          code: "EBLOCKED",
        }),
      );
    }
    return options?.all
      ? callback(null, list)
      : callback(null, list[0].address, list[0].family);
  });
};

const MAX_REDIRECTS = 2;

export const downloadTrustedFile = (
  rawUrl,
  { trustedHosts, maxBytes, timeoutMs = 15000 },
  redirects = 0,
) =>
  new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (_error) {
      reject(
        new BlogToolError(
          "UNTRUSTED_IMAGE_SOURCE",
          "download_url is not a valid URL",
        ),
      );
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      reject(
        new BlogToolError(
          "UNTRUSTED_IMAGE_SOURCE",
          "Only HTTPS file links on the default port are accepted",
        ),
      );
      return;
    }
    if (!hostAllowed(url.hostname, trustedHosts)) {
      // Host only: signed download URLs carry credentials in the query.
      console.warn(
        `MCP image download refused for untrusted host ${url.hostname}`,
      );
      reject(
        new BlogToolError(
          "UNTRUSTED_IMAGE_SOURCE",
          `Files from ${url.hostname} are not accepted`,
        ),
      );
      return;
    }

    const request = https.get(
      url,
      {
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: { accept: "image/*" },
      },
      (response) => {
        const { statusCode = 0 } = response;
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(
              new BlogToolError("IMAGE_DOWNLOAD_FAILED", "Too many redirects"),
            );
            return;
          }
          const next = new URL(response.headers.location, url).href;
          resolve(
            downloadTrustedFile(
              next,
              { trustedHosts, maxBytes, timeoutMs },
              redirects + 1,
            ),
          );
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(
            new BlogToolError(
              "IMAGE_DOWNLOAD_FAILED",
              `File host answered ${statusCode}`,
            ),
          );
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (declared > maxBytes) {
          response.destroy();
          reject(
            new BlogToolError(
              "IMAGE_TOO_LARGE",
              `Image exceeds ${maxBytes} bytes`,
            ),
          );
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(
              new BlogToolError(
                "IMAGE_TOO_LARGE",
                `Image exceeds ${maxBytes} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", () =>
          reject(
            new BlogToolError(
              "IMAGE_DOWNLOAD_FAILED",
              "Download was interrupted",
            ),
          ),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(
        Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      ),
    );
    request.on("error", (error) => {
      reject(
        error?.code === "EBLOCKED"
          ? new BlogToolError(
              "UNTRUSTED_IMAGE_SOURCE",
              "File host resolves to a non-public address",
            )
          : new BlogToolError(
              "IMAGE_DOWNLOAD_FAILED",
              "Could not download the file",
            ),
      );
    });
  });

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const decodeBase64Image = (value, maxBytes) => {
  const text = String(value || "")
    .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!text || text.length % 4 !== 0 || !BASE64.test(text)) {
    throw new BlogToolError("INVALID_IMAGE", "imageBase64 is not valid base64");
  }
  if ((text.length / 4) * 3 > maxBytes + 2) {
    throw new BlogToolError(
      "IMAGE_TOO_LARGE",
      `Image exceeds ${maxBytes} bytes`,
    );
  }
  return Buffer.from(text, "base64");
};

// Returns { buffer, sha256, type: { format, mime }, source }.
export const readImageInput = async (
  { image, imageBase64 },
  {
    maxBytes,
    trustedHosts,
    download = downloadTrustedFile,
    allowedFormats = ["jpg", "png", "webp"],
  },
) => {
  if (Boolean(image) === Boolean(imageBase64)) {
    throw new BlogToolError(
      "VALIDATION_FAILED",
      "Provide exactly one of image (file) or imageBase64",
    );
  }
  const buffer = image
    ? await download(image.download_url, { trustedHosts, maxBytes })
    : decodeBase64Image(imageBase64, maxBytes);
  if (buffer.length > maxBytes) {
    throw new BlogToolError(
      "IMAGE_TOO_LARGE",
      `Image exceeds ${maxBytes} bytes`,
    );
  }
  const type = sniffImageType(buffer);
  if (!type || !allowedFormats.includes(type.format)) {
    throw new BlogToolError(
      "UNSUPPORTED_IMAGE_TYPE",
      `Image must be ${allowedFormats.map((f) => f.toUpperCase()).join(", ")} (checked from the file contents)`,
    );
  }
  return {
    buffer,
    type,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    source: image ? "chatgpt-file" : "base64",
  };
};
