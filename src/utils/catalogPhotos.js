import cloudinary from "cloudinary";

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

export const photoInputError = (message) =>
  Object.assign(new Error(message), { statusCode: 400 });

const INVALID =
  "Each photo must be a data URI, an image URL or { id, secure_url }";

export const resolveCatalogPhotos = async (
  photos,
  {
    folder,
    max = MAX_CATALOG_PHOTOS,
    upload = (value, options) => cloudinary.v2.uploader.upload(value, options),
  },
) => {
  if (photos === undefined || photos === null) return [];
  if (!Array.isArray(photos)) throw photoInputError("photos must be an array");
  if (photos.length > max)
    throw photoInputError(`A maximum of ${max} photos is allowed`);
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
      const result = await upload(value, { folder, resource_type: "image" });
      resolved.push({ id: result.public_id, secure_url: result.secure_url });
    } else if (isOwnCloudinaryUrl(value)) {
      // The URL is authoritative: the CRM may attach a made-up id.
      resolved.push({ id: publicIdFromUrl(value), secure_url: value });
    } else if (/^https:\/\//i.test(value) && isObject && photo.id) {
      resolved.push({ id: String(photo.id), secure_url: value });
    } else if (/^https?:\/\//i.test(value)) {
      const result = await upload(value, { folder, resource_type: "image" });
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
