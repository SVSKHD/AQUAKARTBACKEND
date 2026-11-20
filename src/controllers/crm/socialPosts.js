import { randomUUID } from "node:crypto";
import { toBlogToolError } from "../../services/mcp/errors.js";

// AQUACRM review of social post drafts (AquaSocialPost). Drafts are created
// by the MCP tools; staff list, read, edit, approve or reject them here, and
// publish an approved post as a separate action. Business rules live in
// src/services/mcp/socialTools.js, shared with the MCP tools.

const STATUS_BY_CODE = {
  SOCIAL_POST_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  INVALID_CAPTION: 422,
  INVALID_ASPECT_RATIO: 422,
  PLATFORM_NOT_SUPPORTED: 422,
  REVISION_CONFLICT: 409,
  INVALID_STATUS: 409,
  SOCIAL_POST_NOT_EDITABLE: 409,
  SOCIAL_POST_NOT_APPROVED: 409,
  SOCIAL_POST_NOT_READY: 409,
  DUPLICATE_SOCIAL_POST: 409,
  PUBLISH_IN_PROGRESS: 409,
  PUBLISH_UNCERTAIN: 409,
  ALREADY_POSTED: 409,
  INSTAGRAM_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
};
const EDIT_FIELDS = [
  "title",
  "caption",
  "altText",
  "notes",
  "platforms",
  "scheduledFor",
  "mediaId",
];

const ctxOf = (req) => ({
  auth: {
    clientId: "crm",
    clientName: "AQUACRM",
    adminUserId: String(req.user._id),
    scopes: [],
  },
  correlationId: req.correlationId || randomUUID(),
});

const sendError = (res, caught, log) => {
  const error = toBlogToolError(caught);
  if (error.code === "INTERNAL_ERROR" && caught !== error)
    log.error("Social post request failed:", caught?.message || caught);
  // Unknown codes come from Meta/Cloudinary/storage: a gateway problem.
  const status = STATUS_BY_CODE[error.code] || 502;
  return res.status(status).json({
    success: false,
    code: error.code,
    message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}),
    ...(caught?.retryable !== undefined
      ? { retryable: Boolean(caught.retryable) }
      : {}),
  });
};

export const createSocialPostController = ({ socialTools, log = console }) => {
  const handle = (fn) => async (req, res) => {
    try {
      return res.json({ success: true, ...(await fn(req)) });
    } catch (caught) {
      return sendError(res, caught, log);
    }
  };
  const idParam = (req) => String(req.params.id || "");

  return {
    list: handle((req) => {
      const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 1000);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      const status = req.query.status ? String(req.query.status) : undefined;
      const platform = req.query.platform
        ? String(req.query.platform)
        : undefined;
      return socialTools.listSocialDrafts({
        status,
        platform,
        query: req.query.q ? String(req.query.q).slice(0, 100) : undefined,
        page,
        limit,
      });
    }),

    get: handle((req) => socialTools.getSocialDraft({ postId: idParam(req) })),

    update: handle((req) => {
      const body = req.body || {};
      const fields = Object.fromEntries(
        EDIT_FIELDS.filter((key) => body[key] !== undefined).map((key) => [
          key,
          body[key],
        ]),
      );
      return socialTools.editSocialPost(
        {
          postId: idParam(req),
          expectedRevision: body.expectedRevision,
          ...fields,
        },
        ctxOf(req),
      );
    }),

    approve: handle((req) =>
      socialTools.reviewSocialPost(
        {
          postId: idParam(req),
          decision: "approved",
          note: req.body?.note,
          expectedRevision: req.body?.expectedRevision,
        },
        ctxOf(req),
      ),
    ),

    reject: handle((req) =>
      socialTools.reviewSocialPost(
        {
          postId: idParam(req),
          decision: "rejected",
          note: req.body?.note,
          expectedRevision: req.body?.expectedRevision,
        },
        ctxOf(req),
      ),
    ),

    publish: handle((req) =>
      socialTools.publishSocialPost(
        {
          postId: idParam(req),
          expectedRevision: req.body?.expectedRevision,
        },
        ctxOf(req),
      ),
    ),
  };
};
