import { createSign } from "node:crypto";
import { BlogToolError } from "./errors.js";

// Read-only Google Drive client for aquakart_import_blog_banner.
// Authenticates as a service account (signed JWT -> OAuth access token,
// scope drive.readonly) and talks only to fixed Google hosts, so no
// caller-supplied URL is ever fetched. The service account can read only
// what was shared with its email. Tokens and the private key never leave
// this module: not in results, errors or logs.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;
const FILE_FIELDS =
  "id,name,mimeType,size,md5Checksum,version,trashed,parents,properties,appProperties,imageMediaMetadata(width,height)";

const unavailable = (
  message = "Google Drive is not answering; retry shortly",
) =>
  Object.assign(new BlogToolError("DRIVE_UNAVAILABLE", message), {
    retryable: true,
  });

const notFound = (shareWith) =>
  new BlogToolError(
    "DRIVE_FILE_NOT_FOUND",
    "The Drive file does not exist or is not shared with the Aquakart import account. Share the file (or its Aquakart banner folder) with that account as Viewer, then retry.",
    shareWith ? { shareWith } : undefined,
  );

const b64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const createGoogleDrive = (
  config,
  { fetchImpl = globalThis.fetch, now = () => Date.now() } = {},
) => {
  let cached = null; // { token, expiresAt }

  const call = async (url, init = {}) => {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (_error) {
      // Timeouts and network failures; never echo the URL (it may carry
      // query parameters) or the error object.
      throw unavailable();
    }
  };

  const accessToken = async () => {
    if (cached && cached.expiresAt > now() + 60000) return cached.token;
    let assertion;
    try {
      const iat = Math.floor(now() / 1000);
      const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
        iss: config.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      })}`;
      const signature = createSign("RSA-SHA256")
        .update(unsigned)
        .sign(config.privateKey, "base64url");
      assertion = `${unsigned}.${signature}`;
    } catch (_error) {
      throw new BlogToolError(
        "DRIVE_AUTH_FAILED",
        "The server's Google Drive credentials are invalid; staff must fix GOOGLE_DRIVE_PRIVATE_KEY",
      );
    }
    const response = await call(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (response.status >= 500 || response.status === 429) throw unavailable();
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new BlogToolError(
        "DRIVE_AUTH_FAILED",
        "Google rejected the server's Drive credentials; staff must check the service account and that the Drive API is enabled",
      );
    }
    cached = {
      token: body.access_token,
      expiresAt: now() + Number(body.expires_in || 3600) * 1000,
    };
    return cached.token;
  };

  const request = async (fileId, params) => {
    if (!DRIVE_FILE_ID.test(String(fileId || ""))) {
      throw new BlogToolError(
        "DRIVE_FILE_NOT_FOUND",
        "That is not a valid Google Drive file id",
      );
    }
    const url = `${FILES_URL}/${encodeURIComponent(fileId)}?${new URLSearchParams(
      { supportsAllDrives: "true", ...params },
    )}`;
    const send = async () =>
      call(url, {
        headers: { authorization: `Bearer ${await accessToken()}` },
      });
    let response = await send();
    if (response.status === 401) {
      cached = null; // revoked/expired token: one fresh attempt
      response = await send();
    }
    if (response.ok) return response;
    const body = await response.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || "";
    if (response.status === 404) throw notFound(config.clientEmail);
    if (
      response.status === 429 ||
      response.status >= 500 ||
      /rateLimit/i.test(reason)
    )
      throw unavailable();
    if (response.status === 403) {
      throw new BlogToolError(
        "DRIVE_ACCESS_DENIED",
        reason === "cannotDownloadAbusiveFile"
          ? "Google flagged this file and refuses to download it"
          : "The Aquakart import account may not read this Drive file; share it (or its folder) with that account as Viewer",
        { shareWith: config.clientEmail },
      );
    }
    if (response.status === 401) {
      throw new BlogToolError(
        "DRIVE_AUTH_FAILED",
        "Google rejected the server's Drive credentials",
      );
    }
    throw new BlogToolError(
      "DRIVE_REQUEST_FAILED",
      `Google Drive answered ${response.status}`,
    );
  };

  return {
    configured: Boolean(config.configured),
    shareWith: config.clientEmail || null,

    // Metadata of a file or folder (folders are read to check ancestry).
    async getFile(fileId) {
      const response = await request(fileId, { fields: FILE_FIELDS });
      return response.json();
    },

    // File bytes, streamed with a hard byte cap.
    async download(fileId, { maxBytes }) {
      const response = await request(fileId, { alt: "media" });
      const declared = Number(response.headers.get("content-length"));
      const tooLarge = () =>
        new BlogToolError("IMAGE_TOO_LARGE", `Image exceeds ${maxBytes} bytes`);
      if (declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw tooLarge();
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof BlogToolError) throw error;
        throw unavailable("The Drive download was interrupted; retry");
      }
      return Buffer.concat(chunks);
    },
  };
};
