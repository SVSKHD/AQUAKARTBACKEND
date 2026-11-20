import sanitizeHtml from "sanitize-html";
import { BlogToolError } from "../../services/mcp/errors.js";
import { slugify } from "../../jobs/aiBlogDrafts.js";

// Sanitizing/normalizing for blog content arriving through the MCP tools.
// Shapes and lengths are enforced by the tools' strict zod input schemas;
// this module cleans HTML/text and maps values onto AquaBlog fields.

export const OBJECT_ID = /^[a-f\d]{24}$/i;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export const isObjectId = (value) =>
  typeof value === "string" && OBJECT_ID.test(value);

// Allowlist: article structure, emphasis, lists, tables and links. No
// images (they go through aquakart_upload_image), no inline styles, no
// scripts, no iframes. <h1> becomes <h2>: the page already renders the title.
const SANITIZE_OPTIONS = {
  allowedTags: [
    "p",
    "h2",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "a",
    "blockquote",
    "br",
    "hr",
    "code",
    "pre",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe"],
  transformTags: {
    h1: "h2",
    a: (tagName, attribs) => {
      const next = { ...attribs };
      if (next.target === "_blank") next.rel = "noopener noreferrer";
      else delete next.target;
      return { tagName, attribs: next };
    },
  },
};

export const sanitizeBlogHtml = (html) =>
  sanitizeHtml(String(html || ""), SANITIZE_OPTIONS).trim();

export const stripText = (html) =>
  String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export const countWords = (html) =>
  stripText(html).split(" ").filter(Boolean).length;

export const normalizeTitleKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Plain-text fields never carry markup (the storefront escapes text, so
// stripping tags is enough and keeps "&" readable).
const cleanText = (value) =>
  String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const cleanList = (items) => {
  const seen = new Set();
  return items.map(cleanText).filter((item) => {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const TEXT_FIELDS = [
  "title",
  "shortDescription",
  "summary",
  "notes",
  "brand",
  "titleImageAlt",
];
const JOINED_LIST_FIELDS = ["keywords", "keyphrases"];
const LIST_FIELDS = ["keyHighlights", "tags"];
const REFERENCE_FIELDS = ["category", "subCategory", "product"];

// Maps validated tool input onto AquaBlog fields. Fields left undefined are
// untouched on update; null clears a text/list/reference field.
// Returns { blog, htmlSanitized }.
export const normalizeBlogFields = (input, { partial = false } = {}) => {
  const blog = {};
  for (const field of TEXT_FIELDS) {
    if (input[field] !== undefined) {
      blog[field] = input[field] === null ? "" : cleanText(input[field]);
    }
  }
  for (const field of JOINED_LIST_FIELDS) {
    if (input[field] !== undefined) {
      blog[field] = cleanList(input[field] || []).join(", ");
    }
  }
  for (const field of LIST_FIELDS) {
    if (input[field] !== undefined) blog[field] = cleanList(input[field] || []);
  }
  for (const field of REFERENCE_FIELDS) {
    if (input[field] !== undefined) blog[field] = input[field] || null;
  }

  let htmlSanitized = false;
  if (input.description !== undefined) {
    blog.description = sanitizeBlogHtml(input.description);
    htmlSanitized = blog.description !== String(input.description).trim();
  }
  if (input.slug !== undefined) blog.slug = input.slug;

  const errors = [];
  if (blog.title !== undefined && blog.title.length < 10) {
    errors.push({
      field: "title",
      message: "needs at least 10 characters of text",
    });
  }
  if (blog.description !== undefined && !countWords(blog.description)) {
    errors.push({
      field: "description",
      message: "has no text after sanitizing",
    });
  }
  if (blog.brand !== undefined && !blog.brand) {
    errors.push({ field: "brand", message: "cannot be empty" });
  }
  if (errors.length) {
    throw new BlogToolError(
      "VALIDATION_FAILED",
      "Invalid blog content",
      errors,
    );
  }

  if (!partial) {
    blog.brand = blog.brand || "Aquakart";
    if (!blog.slug) blog.slug = slugify(blog.title);
  }
  return { blog, htmlSanitized };
};

// Identifies the real format from the file's first bytes; declared MIME
// types and file names are never trusted.
export const sniffImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { format: "jpg", mime: "image/jpeg" };
  }
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { format: "png", mime: "image/png" };
  }
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { format: "webp", mime: "image/webp" };
  }
  return null;
};

// JPEG start-of-frame markers that carry the frame size (not DHT C4, JPG
// C8 or DAC CC).
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

// Width and height read from the image header itself (never from declared
// metadata). Returns null when the header is truncated or malformed.
export const imageDimensions = (buffer, format) => {
  try {
    if (format === "png") {
      if (buffer.length < 24 || buffer.toString("latin1", 12, 16) !== "IHDR")
        return null;
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }
    if (format === "jpg") {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) return null;
        const marker = buffer[i + 1];
        if (marker === 0xff) {
          i += 1; // fill byte
        } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2; // standalone marker, no length
        } else if (JPEG_SOF.has(marker)) {
          return {
            height: buffer.readUInt16BE(i + 5),
            width: buffer.readUInt16BE(i + 7),
          };
        } else {
          i += 2 + buffer.readUInt16BE(i + 2);
        }
      }
      return null;
    }
    if (format === "webp") {
      const chunk = buffer.toString("latin1", 12, 16);
      if (chunk === "VP8 " && buffer.length >= 30)
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      if (chunk === "VP8L" && buffer.length >= 25) {
        const [b0, b1, b2, b3] = buffer.subarray(21, 25);
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
      if (chunk === "VP8X" && buffer.length >= 30)
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        };
    }
  } catch (_error) {
    return null;
  }
  return null;
};
