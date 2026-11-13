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
