import { createHash } from "node:crypto";
import { BlogToolError } from "./errors.js";
import { imageDimensions, sniffImageType } from "../../validators/mcp/blog.js";

// Shared Google Drive import rules for MCP tools that read Aquakart's Drive
// folder (blog banners, social posters and captions). Works on the
// injected client from googleDrive.js, so it is tested with a fake Drive.
// Every file must be inside GOOGLE_DRIVE_BANNER_FOLDER_IDS (or a subfolder),
// not trashed, and of an accepted type; images are checked from their bytes.

// Drive MIME type -> format the bytes must actually have.
export const IMAGE_MIMES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const GOOGLE_DOC = "application/vnd.google-apps.document";
const TEXT_MIMES = ["text/plain", "text/markdown"];

// md5Checksum changes only with the bytes; Google Docs have none, so their
// revision counter stands in.
export const versionOf = (file) =>
  file.md5Checksum || `v${file.version || "0"}`;

export const createDriveImporter = ({ drive, config }) => {
  const ensureConfigured = () => {
    if (!drive?.configured || !config.drive?.configured)
      throw new BlogToolError(
        "DRIVE_NOT_CONFIGURED",
        "Google Drive import is not set up on this server; staff must configure the Drive service account (see docs/MCP_BLOG_PUBLISHING.md)",
      );
  };

  // The file must sit in (or under) an allowed Aquakart folder. Folders the
  // service account cannot see end that branch of the walk.
  const assertAllowedFolder = async (file) => {
    const allowed = new Set(config.drive.folderIds);
    const seen = new Set();
    let frontier = file.parents || [];
    for (
      let depth = 0;
      depth <= config.drive.folderDepth && frontier.length;
      depth += 1
    ) {
      if (frontier.some((id) => allowed.has(id))) return;
      const next = [];
      for (const id of frontier) {
        if (!seen.has(id)) {
          seen.add(id);
          try {
            next.push(...((await drive.getFile(id)).parents || []));
          } catch (error) {
            if (
              !["DRIVE_FILE_NOT_FOUND", "DRIVE_ACCESS_DENIED"].includes(
                error?.code,
              )
            )
              throw error;
          }
        }
      }
      frontier = next;
    }
    throw new BlogToolError(
      "DRIVE_FOLDER_NOT_ALLOWED",
      "That file is not inside the Aquakart content folder; move it there (or share that folder with the import account) and retry",
    );
  };

  // Metadata of an allowed, non-trashed file.
  const inspect = async (fileId) => {
    ensureConfigured();
    const file = await drive.getFile(fileId);
    if (file.trashed)
      throw new BlogToolError(
        "DRIVE_FILE_NOT_FOUND",
        "That Drive file is in the trash",
      );
    await assertAllowedFolder(file);
    return file;
  };

  return {
    ensureConfigured,
    assertAllowedFolder,
    inspect,

    // Metadata-only image checks (no download): type and declared size.
    async inspectImage(fileId) {
      const file = await inspect(fileId);
      if (!IMAGE_MIMES[file.mimeType])
        throw new BlogToolError(
          "UNSUPPORTED_IMAGE_TYPE",
          "The image must be a JPG, PNG or WEBP file",
          { mimeType: file.mimeType || null },
        );
      if (Number(file.size) > config.imageMaxBytes)
        throw new BlogToolError(
          "IMAGE_TOO_LARGE",
          `Image exceeds ${config.imageMaxBytes} bytes`,
        );
      return file;
    },

    // Downloads an inspected image and verifies it from its bytes.
    // Returns the input shape blogTools.storeImage expects.
    async downloadImage(file, { minWidth, minHeight, maxDimension, label }) {
      const buffer = await drive.download(file.id, {
        maxBytes: config.imageMaxBytes,
      });
      if (!buffer.length)
        throw new BlogToolError("INVALID_IMAGE", "The file is empty");
      const type = sniffImageType(buffer);
      if (!type || IMAGE_MIMES[file.mimeType] !== type.format)
        throw new BlogToolError(
          "UNSUPPORTED_IMAGE_TYPE",
          "The file contents are not the JPG, PNG or WEBP image Drive reports",
        );
      const size = imageDimensions(buffer, type.format);
      if (!size)
        throw new BlogToolError(
          "INVALID_IMAGE",
          "The image header could not be read; re-export the file",
        );
      if (
        size.width < minWidth ||
        size.height < minHeight ||
        Math.max(size.width, size.height) > maxDimension
      )
        throw new BlogToolError(
          "IMAGE_DIMENSIONS_INVALID",
          `${label} must be at least ${minWidth}x${minHeight} and at most ${maxDimension}px on a side`,
          { width: size.width, height: size.height },
        );
      return {
        buffer,
        type,
        size,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        source: "google-drive",
        sourceRef: {
          type: "google_drive",
          fileId: file.id,
          version: versionOf(file),
          name: String(file.name || "").slice(0, 200),
        },
      };
    },

    // Plain text from a .txt/.md file or a Google Doc (exported as text).
    async readText(fileId, { maxBytes = 20000 } = {}) {
      const file = await inspect(fileId);
      let buffer;
      if (file.mimeType === GOOGLE_DOC) {
        buffer = await drive.exportText(file.id, { maxBytes });
      } else if (TEXT_MIMES.includes(file.mimeType)) {
        if (Number(file.size) > maxBytes)
          throw new BlogToolError(
            "TEXT_TOO_LARGE",
            `Text file exceeds ${maxBytes} bytes`,
          );
        buffer = await drive.download(file.id, {
          maxBytes,
          tooLargeCode: "TEXT_TOO_LARGE",
        });
      } else {
        throw new BlogToolError(
          "UNSUPPORTED_SOURCE_FILE",
          "Text must be a .txt/.md file or a Google Doc",
          { mimeType: file.mimeType || null },
        );
      }
      const text = buffer.toString("utf8").replace(/^﻿/, "").trim();
      return { file, text, version: versionOf(file) };
    },

    // A JSON object from a .json (or plain text) file.
    async readJson(fileId, { maxBytes = 20000 } = {}) {
      const file = await inspect(fileId);
      if (!["application/json", ...TEXT_MIMES].includes(file.mimeType))
        throw new BlogToolError(
          "UNSUPPORTED_SOURCE_FILE",
          "Metadata must be a .json file",
          { mimeType: file.mimeType || null },
        );
      if (Number(file.size) > maxBytes)
        throw new BlogToolError(
          "TEXT_TOO_LARGE",
          `Metadata file exceeds ${maxBytes} bytes`,
        );
      const buffer = await drive.download(file.id, {
        maxBytes,
        tooLargeCode: "TEXT_TOO_LARGE",
      });
      let data;
      try {
        data = JSON.parse(buffer.toString("utf8").replace(/^﻿/, ""));
      } catch (_error) {
        throw new BlogToolError(
          "INVALID_METADATA",
          "The metadata file is not valid JSON",
        );
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new BlogToolError(
          "INVALID_METADATA",
          "The metadata file must contain a JSON object",
        );
      return { file, data, version: versionOf(file) };
    },
  };
};
