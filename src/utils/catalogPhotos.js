import cloudinary from "cloudinary";
import AquaBlog from "../models/blog.js";
import AquaCategory from "../models/category.js";
import AquaProduct from "../models/product.js";
import AquaSubCategory from "../models/sub-category.js";

// Photo lists for catalog records (categories, subcategories) sent as JSON
// by the CRM. The CRM's photo uploader sends every photo as
// { id, secure_url }:
// - existing photos keep their Cloudinary public id and https URL
// - newly picked files have a random id and a data: URI as secure_url
// Rules:
// - a data: URI is always uploaded (whatever id it carries)
// - a URL in our Cloudinary account is kept, with the public id read from
//   the URL; another https URL with an id is kept as it is (no re-upload)
// - other http(s) URLs are uploaded to the folder
// - anything else is a 400

export const MAX_CATALOG_PHOTOS = 10;
const DATA_URI = /^data:image\/[\w.+-]+;base64,/i;

export const photoInputError = (message) =>
  Object.assign(new Error(message), { statusCode: 400 });

// ── Image input checks ─────────────────────────────────────────────────────
// Cloudinary's per-image limit (free plan) is 10 MB; reject before uploading.
export const maxImageBytes = () =>
  Number(process.env.CATALOG_MAX_IMAGE_BYTES) || 10 * 1024 * 1024;

const SIGNATURES = {
  png: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x89504e47,
  jpeg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.toString("latin1", 0, 4) === "GIF8",
  webp: (b) =>
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP",
  avif: (b) =>
    b.toString("latin1", 4, 8) === "ftyp" &&
    /^avi[fs]$/.test(b.toString("latin1", 8, 12)),
  // iPhone photos; Cloudinary accepts HEIC/HEIF.
  heic: (b) =>
    b.toString("latin1", 4, 8) === "ftyp" &&
    /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(b.toString("latin1", 8, 12)),
  bmp: (b) => b.toString("latin1", 0, 2) === "BM",
  tiff: (b) => ["II*\0", "MM\0*"].includes(b.toString("latin1", 0, 4)),
  // SVG is deliberately absent: it can carry scripts.
};
const ALIASES = { jpg: "jpeg", pjpeg: "jpeg", heif: "heic", tif: "tiff" };
const normalizeImageType = (type = "") => {
  const value = String(type)
    .toLowerCase()
    .replace(/^image\//, "")
    .replace(/^x-/, "");
  return ALIASES[value] || value;
};

export const detectImageType = (buffer) =>
  Object.keys(SIGNATURES).find((type) => SIGNATURES[type](buffer)) || null;

export const photoTooLargeError = () =>
  Object.assign(
    new Error(
      `Each image must be ${Math.floor(maxImageBytes() / 1048576)} MB or smaller`,
    ),
    { statusCode: 413 },
  );

const UNSUPPORTED =
  "Unsupported image. Use a JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF file";

// Checks an uploaded file's size and real type (magic bytes). The declared
// MIME type is not trusted: browsers may send application/octet-stream, and
// a mislabelled but real image is still accepted (Cloudinary reads content).
export const assertImageBuffer = (buffer, declaredType) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length)
    throw photoInputError("Uploaded file is empty");
  if (buffer.length > maxImageBytes()) throw photoTooLargeError();
  const declared = normalizeImageType(declaredType);
  if (/^svg/.test(declared)) throw photoInputError(UNSUPPORTED);
  const actual = detectImageType(buffer);
  if (!actual) throw photoInputError(UNSUPPORTED);
  return actual;
};

// Checks a base64 data URI without decoding all of it.
export const assertImageDataUri = (value) => {
  const match = /^data:image\/([\w.+-]+);base64,/i.exec(value);
  if (!match) throw photoInputError(UNSUPPORTED);
  const declared = normalizeImageType(match[1]);
  if (!SIGNATURES[declared]) throw photoInputError(UNSUPPORTED);
  const base64 = value.slice(match[0].length).replace(/\s/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if (Math.floor((base64.length * 3) / 4) - padding > maxImageBytes())
    throw photoTooLargeError();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw photoInputError(UNSUPPORTED);
  // The content must be a supported image (a mislabelled one is accepted).
  const actual = detectImageType(Buffer.from(base64.slice(0, 24), "base64"));
  if (!actual) throw photoInputError(UNSUPPORTED);
  return actual;
};

// Case-insensitive, whitespace-tolerant exact title match (same rule as the
// MCP taxonomy tools), for duplicate checks.
export const exactTitleFilter = (title) =>
  new RegExp(
    `^\\s*${String(title)
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "i",
  );

const ownCloud = () =>
  cloudinary.v2.config().cloud_name || process.env.CLOUDINARY_NAME || "";

export const isOwnCloudinaryUrl = (url) => {
  try {
    const { protocol, hostname, pathname } = new URL(url);
    if (protocol !== "https:" || hostname !== "res.cloudinary.com")
      return false;
    const cloud = ownCloud();
    return !cloud || pathname.startsWith(`/${cloud}/`);
  } catch {
    return false;
  }
};

// .../image/upload/<transformations>/v123/<folder>/<name>.<ext> -> <folder>/<name>
export const publicIdFromUrl = (url) => {
  const path = new URL(url).pathname.split("/upload/")[1] || "";
  const parts = path.split("/").filter(Boolean);
  const version = parts.findIndex((part) => /^v\d+$/.test(part));
  const rest =
    version >= 0
      ? parts.slice(version + 1)
      : parts.filter((part) => !part.includes(","));
  return decodeURIComponent(rest.join("/")).replace(/\.[a-z0-9]+$/i, "");
};

const INVALID =
  "Each photo must be a data URI, an image URL or { id, secure_url }";

export const resolveCatalogPhotos = async (
  photos,
  {
    folder,
    max = MAX_CATALOG_PHOTOS,
    upload = (value, options) => cloudinary.v2.uploader.upload(value, options),
    // Receives every new upload, so callers can remove them if the DB write fails.
    uploaded = [],
  },
) => {
  if (photos === undefined || photos === null) return [];
  if (!Array.isArray(photos)) throw photoInputError("photos must be an array");
  if (photos.length > max)
    throw photoInputError(`A maximum of ${max} photos is allowed`);
  // Check every data URI before uploading any of them.
  for (const photo of photos) {
    const raw =
      typeof photo === "string"
        ? photo
        : photo?.secure_url || photo?.url || photo?.src;
    if (typeof raw === "string" && DATA_URI.test(raw.trim()))
      assertImageDataUri(raw.trim());
  }
  const track = async (value, options) => {
    const result = await upload(value, options);
    uploaded.push({ id: result.public_id, secure_url: result.secure_url });
    return result;
  };
  const resolved = [];
  for (const photo of photos) {
    const isObject = photo && typeof photo === "object";
    const raw =
      typeof photo === "string"
        ? photo
        : isObject
          ? photo.secure_url || photo.url || photo.src
          : null;
    if (typeof raw !== "string" || !raw.trim()) throw photoInputError(INVALID);
    const value = raw.trim();
    if (DATA_URI.test(value)) {
      const result = await track(value, { folder, resource_type: "image" });
      resolved.push({ id: result.public_id, secure_url: result.secure_url });
    } else if (isOwnCloudinaryUrl(value)) {
      // The URL is authoritative: the CRM may attach a made-up id.
      resolved.push({ id: publicIdFromUrl(value), secure_url: value });
    } else if (/^https:\/\//i.test(value) && isObject && photo.id) {
      resolved.push({ id: String(photo.id), secure_url: value });
    } else if (/^https?:\/\//i.test(value)) {
      const result = await track(value, { folder, resource_type: "image" });
      resolved.push({ id: result.public_id, secure_url: result.secure_url });
    } else {
      throw photoInputError(INVALID);
    }
  }
  return resolved;
};

// Photos present before but not in the new list (by public id or URL);
// only these may be deleted from Cloudinary after a successful update.
export const removedPhotos = (before = [], after = []) => {
  const kept = new Set(
    after.flatMap((photo) => [photo?.id, photo?.secure_url]).filter(Boolean),
  );
  return before.filter(
    (photo) => photo?.id && !kept.has(photo.id) && !kept.has(photo.secure_url),
  );
};

// ── Cloudinary cleanup ─────────────────────────────────────────────────────
// Cleanup runs after the response (never blocks a request), retries once and
// logs the public id when it still fails.

// destroy() needs image/video/raw ("auto" is upload-only): read it from the URL.
export const cloudinaryResourceType = (url) => {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== "res.cloudinary.com") return null;
    return /^\/[^/]+\/(image|video|raw)\/upload\//.exec(pathname)?.[1] || null;
  } catch {
    return null;
  }
};

const MEDIA_FIELDS = [
  [AquaCategory, ["photos"]],
  [AquaSubCategory, ["photos"]],
  [AquaProduct, ["photos", "arPhotos"]],
  [AquaBlog, ["titleImages", "photos"]],
];

// True when any category, subcategory, product or blog still shows the image.
export const mediaInUse = async ({ id, secure_url: url }) => {
  for (const [Model, fields] of MEDIA_FIELDS) {
    const $or = fields.flatMap((field) => [
      { [`${field}.id`]: id },
      ...(url ? [{ [`${field}.secure_url`]: url }] : []),
    ]);
    if (await Model.exists({ $or })) return true;
  }
  return false;
};

const destroyWithRetry = async (id, resourceType) => {
  const destroy = () =>
    cloudinary.v2.uploader.destroy(id, { resource_type: resourceType });
  try {
    return await destroy();
  } catch {
    return destroy();
  }
};

const ownMedia = (item) =>
  Boolean(item?.id) && isOwnCloudinaryUrl(item?.secure_url);

const destroyMedia = async (media, { checkReferences }) => {
  for (const item of media || []) {
    // External URLs and made-up ids (external_...) are not ours to delete.
    if (!ownMedia(item)) continue;
    try {
      if (checkReferences && (await mediaInUse(item))) continue;
      await destroyWithRetry(
        item.id,
        cloudinaryResourceType(item.secure_url) || "image",
      );
    } catch (error) {
      console.error(
        `Cloudinary cleanup failed for ${item.id}:`,
        error?.message || error,
      );
    }
  }
};

const pendingCleanups = new Set();
const schedule = (media, options) => {
  if (!media?.length) return;
  const job = destroyMedia(media, options).finally(() =>
    pendingCleanups.delete(job),
  );
  pendingCleanups.add(job);
};

// Media removed from a record (after the DB write succeeded): deleted only
// when no other record still uses it.
export const scheduleMediaCleanup = (media) =>
  schedule(media, { checkReferences: true });

// Uploads made by a request whose DB write then failed: nothing references
// them yet, so they are deleted directly.
export const scheduleUploadCleanup = (uploaded) =>
  schedule(uploaded, { checkReferences: false });

// For tests and graceful shutdown: resolves when queued cleanups finish.
export const settleMediaCleanup = () => Promise.all([...pendingCleanups]);
