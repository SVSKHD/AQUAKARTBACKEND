import mongoose from "mongoose";
import Seo from "../models/seo.js";
import { writeAudit } from "../services/audit.js";

const EDITABLE_FIELDS = Object.freeze([
  "pageKey",
  "route",
  "title",
  "description",
  "keywords",
  "canonicalUrl",
  "robots",
  "ogTitle",
  "ogDescription",
  "ogImage",
  "twitterTitle",
  "twitterDescription",
  "twitterImage",
  "schemaJson",
  "active",
]);

const normalizePageKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeKeywords = (value) => {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [
    ...new Set(values.map((keyword) => String(keyword).trim()).filter(Boolean)),
  ];
};

const normalizeSchemaJson = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      const error = new Error("schemaJson must contain valid JSON");
      error.statusCode = 400;
      throw error;
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("schemaJson must be a JSON object");
    error.statusCode = 400;
    throw error;
  }
  return value;
};

const validateRoute = (route) => {
  if (!String(route || "").startsWith("/")) {
    const error = new Error("route must start with /");
    error.statusCode = 400;
    throw error;
  }
};

const validateOptionalUrl = (value, field) => {
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    const error = new Error(`${field} must be a valid absolute URL`);
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error(`${field} must use http or https`);
    error.statusCode = 400;
    throw error;
  }
};

export const buildSeoPayload = (body = {}, { partial = false } = {}) => {
  const payload = {};
  EDITABLE_FIELDS.forEach((field) => {
    if (body[field] !== undefined) payload[field] = body[field];
  });

  if (payload.pageKey !== undefined)
    payload.pageKey = normalizePageKey(payload.pageKey);
  if (payload.keywords !== undefined)
    payload.keywords = normalizeKeywords(payload.keywords);
  if (payload.schemaJson !== undefined)
    payload.schemaJson = normalizeSchemaJson(payload.schemaJson);
  if (payload.route !== undefined) validateRoute(payload.route);
  ["canonicalUrl", "ogImage", "twitterImage"].forEach((field) => {
    if (payload[field] !== undefined)
      validateOptionalUrl(payload[field], field);
  });

  if (!partial) {
    for (const field of ["pageKey", "route", "title"]) {
      if (!String(payload[field] || "").trim()) {
        const error = new Error(`${field} is required`);
        error.statusCode = 400;
        throw error;
      }
    }
  }
  return payload;
};

const sendError = (error, res, fallback) => {
  if (error?.code === 11000) {
    return res
      .status(409)
      .json({ success: false, message: "pageKey already exists" });
  }
  if (error?.name === "ValidationError") {
    return res.status(400).json({ success: false, message: error.message });
  }
  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : fallback,
  });
};

export const getPublicSeo = async (req, res) => {
  const pageKey = normalizePageKey(req.params.pageKey);
  const seo = await Seo.findOne({ pageKey, active: true })
    .select("-createdBy -updatedBy -__v")
    .lean();
  if (!seo) {
    return res
      .status(404)
      .json({ success: false, message: "SEO configuration not found" });
  }
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  return res.json({ success: true, data: seo });
};

export const listSeo = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = {};
  if (req.query.active === "true") filter.active = true;
  if (req.query.active === "false") filter.active = false;
  if (req.query.search) {
    const search = escapeRegex(String(req.query.search).trim().slice(0, 100));
    filter.$or = [
      { pageKey: { $regex: search, $options: "i" } },
      { route: { $regex: search, $options: "i" } },
      { title: { $regex: search, $options: "i" } },
    ];
  }
  const [data, total] = await Promise.all([
    Seo.find(filter)
      .sort({ pageKey: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Seo.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

export const getSeoById = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid SEO id" });
  }
  const seo = await Seo.findById(req.params.id).lean();
  if (!seo)
    return res
      .status(404)
      .json({ success: false, message: "SEO configuration not found" });
  return res.json({ success: true, data: seo });
};

export const createSeo = async (req, res) => {
  try {
    const payload = buildSeoPayload(req.body);
    const seo = await Seo.create({
      ...payload,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await writeAudit({
      req,
      action: "seo.create",
      resourceType: "seo",
      resourceId: seo._id,
      after: seo,
    });
    return res.status(201).json({ success: true, data: seo });
  } catch (error) {
    return sendError(error, res, "Unable to create SEO configuration");
  }
};

const updateSeo = async (req, res, { partial }) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid SEO id" });
    }
    const seo = await Seo.findById(req.params.id);
    if (!seo)
      return res
        .status(404)
        .json({ success: false, message: "SEO configuration not found" });
    const before = seo.toObject();
    const payload = buildSeoPayload(req.body, { partial });
    if (!partial) {
      EDITABLE_FIELDS.forEach((field) => {
        if (payload[field] === undefined && !["active"].includes(field))
          seo[field] = undefined;
      });
    }
    Object.assign(seo, payload, { updatedBy: req.user._id });
    await seo.save();
    await writeAudit({
      req,
      action: partial ? "seo.patch" : "seo.update",
      resourceType: "seo",
      resourceId: seo._id,
      before,
      after: seo,
    });
    return res.json({ success: true, data: seo });
  } catch (error) {
    return sendError(error, res, "Unable to update SEO configuration");
  }
};

export const replaceSeo = (req, res) => updateSeo(req, res, { partial: false });
export const patchSeo = (req, res) => updateSeo(req, res, { partial: true });
