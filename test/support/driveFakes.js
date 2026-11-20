// Scriptable Google Drive and image fixtures shared by the Drive import
// tests (blog banners, social drafts). No network.
import { randomBytes } from "node:crypto";
import { BlogToolError } from "../../src/services/mcp/errors.js";

export const FOLDER = "folderBanners0001";
export const SUBFOLDER = "folderBannersSub01";
export const OTHER_FOLDER = "folderSomewhereElse";
export const DRIVE_ENV = {
  GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL:
    "banner-importer@aquakart-test.iam.gserviceaccount.com",
  GOOGLE_DRIVE_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----",
  GOOGLE_DRIVE_BANNER_FOLDER_IDS: FOLDER,
};
// Minimal but well-formed image headers with real dimensions.
export const pngOf = (width, height, seed = randomBytes(8)) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.from(seed),
  ]);
};
// Scriptable Drive: files by id; unknown ids are "not found", `denied` ids
// answer like a file the service account may not read.
export const createFakeDrive = () => {
  const drive = {
    configured: true,
    shareWith: DRIVE_ENV.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL,
    files: new Map([
      [FOLDER, { id: FOLDER, parents: ["rootFolder000001"] }],
      [SUBFOLDER, { id: SUBFOLDER, parents: [FOLDER] }],
      [OTHER_FOLDER, { id: OTHER_FOLDER, parents: [] }],
    ]),
    bytes: new Map(),
    denied: new Set(),
    calls: { getFile: 0, download: 0 },
    add(id, buffer, meta = {}) {
      drive.files.set(id, {
        id,
        name: `${id}.png`,
        mimeType: "image/png",
        size: String(buffer.length),
        md5Checksum: `md5-${id}-${buffer.length}`,
        version: "3",
        trashed: false,
        parents: [FOLDER],
        ...meta,
      });
      drive.bytes.set(id, buffer);
    },
    async getFile(id) {
      drive.calls.getFile += 1;
      if (drive.denied.has(id))
        throw new BlogToolError("DRIVE_ACCESS_DENIED", "denied", {
          shareWith: drive.shareWith,
        });
      const file = drive.files.get(id);
      if (!file) throw new BlogToolError("DRIVE_FILE_NOT_FOUND", "not found");
      return structuredClone(file);
    },
    // A text/JSON file, or a Google Doc (exported as text).
    addText(id, text, meta = {}) {
      const buffer = Buffer.from(text, "utf8");
      drive.add(id, buffer, {
        name: `${id}.txt`,
        mimeType: "text/plain",
        ...meta,
      });
    },
    async download(id, { maxBytes, tooLargeCode = "IMAGE_TOO_LARGE" }) {
      drive.calls.download += 1;
      const buffer = drive.bytes.get(id);
      if (buffer.length > maxBytes)
        throw new BlogToolError(tooLargeCode, "too large");
      return Buffer.from(buffer);
    },
    async exportText(id, { maxBytes }) {
      drive.calls.export = (drive.calls.export || 0) + 1;
      const buffer = drive.bytes.get(id);
      if (buffer.length > maxBytes)
        throw new BlogToolError("TEXT_TOO_LARGE", "too large");
      return Buffer.from(buffer);
    },
  };
  return drive;
};
