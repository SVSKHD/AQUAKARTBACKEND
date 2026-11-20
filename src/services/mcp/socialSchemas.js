import * as z from "zod";
import { MCP_SCOPES } from "./config.js";
import { DRIVE_FILE_ID } from "./googleDrive.js";
import { IDEMPOTENCY_KEY, OBJECT_ID } from "../../validators/mcp/blog.js";

// MCP tool definitions for social post drafts (socialTools.js). The
// `register` helper from server.js adds scope checks, envelopes and logs.
// There is deliberately no approve tool: approval happens in the CRM.

const objectId = z.string().regex(OBJECT_ID, "must be a 24-character id");
const driveId = z.string().regex(DRIVE_FILE_ID, "must be a Google Drive id");
const idempotencyKey = z
  .string()
  .regex(IDEMPOTENCY_KEY, "8-128 letters, digits, '.', '_', ':' or '-'")
  .describe(
    "Unique per intended action. Reuse the SAME key when retrying after a timeout; never reuse it for a different action.",
  );
const expectedRevision = z
  .string()
  .max(40)
  .optional()
  .describe(
    "Revision from your last read; fails with REVISION_CONFLICT if the post changed since.",
  );
const envelope = (shape, write = false) =>
  z.object({
    ok: z.literal(true),
    correlationId: z.string(),
    ...(write ? { operationId: z.string(), replayed: z.boolean() } : {}),
    ...shape,
  });
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

const platforms = z
  .array(z.enum(["instagram", "facebook"]))
  .min(1)
  .max(2)
  .describe(
    "Target platforms. Facebook is stored as a target, but only Instagram can be published for now.",
  );
const fields = {
  title: z
    .string()
    .min(3)
    .max(150)
    .describe("Internal title shown to reviewers in the CRM"),
  caption: z
    .string()
    .min(1)
    .max(5000)
    .describe(
      "Post caption with hashtags, plain text. Instagram: max 2,200 characters, 30 hashtags, 20 @mentions.",
    ),
  altText: z
    .string()
    .max(1000)
    .describe("Accessible description of the poster"),
  notes: z.string().max(1000).describe("Note for reviewers; never posted"),
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .describe(
      "Preferred posting time from the content plan (ISO). Informational: nothing posts automatically.",
    ),
};

const issue = z.object({ check: z.string(), message: z.string() });
const publishState = z
  .object({
    status: z.string(),
    assetId: z.string().nullable(),
    externalId: z.string().nullable(),
    permalink: z.string().nullable(),
    publishedAt: z.string().nullable(),
    lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .nullable();
export const socialPostShape = z.object({
  postId: z.string(),
  title: z.string(),
  platforms: z.array(z.string()),
  status: z.enum(["draft", "approved", "rejected", "publishing", "published"]),
  caption: z.string(),
  altText: z.string(),
  notes: z.string(),
  scheduledFor: z.string().nullable(),
  revision: z.string(),
  image: z
    .object({
      mediaId: z.string().nullable(),
      imageUrl: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      format: z.string().nullable(),
      bytes: z.number().nullable(),
    })
    .nullable(),
  source: z.object({
    type: z.string(),
    folderId: z.string().nullable(),
    imageFileId: z.string().nullable(),
    captionFileId: z.string().nullable(),
    metadataFileId: z.string().nullable(),
  }),
  review: z
    .object({
      decision: z.enum(["approved", "rejected"]),
      by: z.string().nullable(),
      at: z.string().nullable(),
      note: z.string(),
    })
    .nullable(),
  publishing: z.object({ instagram: publishState, facebook: publishState }),
  publishedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  checks: z.object({
    readyForReview: z.boolean(),
    problems: z.array(issue),
    warnings: z.array(issue),
  }),
});

export const registerSocialTools = (register, socialTools) => {
  register(
    "aquakart_create_social_draft",
    {
      title: "Create social post draft",
      description:
        "Create an UNPUBLISHED Instagram/Facebook post draft for staff review in the CRM. Give the poster either as mediaId (upload it first with aquakart_create_image_upload or aquakart_upload_image) or as source { type: 'google_drive', imageFileId, captionFileId?, metadataFileId?, folderId? } from the Aquakart Drive folder (read server-side; caption from a .txt/.md file or Google Doc; metadata JSON may hold title, platforms, altText, notes, scheduledFor, caption). Explicit arguments win over file values. The poster is checked (Instagram: 4:5 to 1.91:1, at least 320px wide) and stored in Aquakart's Cloudinary. Creating the same poster + caption + platforms again returns the existing post with alreadyExists: true. Never approves or publishes; read it back with aquakart_get_social_draft.",
      scopes: [MCP_SCOPES.socialWrite, MCP_SCOPES.upload],
      input: z.strictObject({
        idempotencyKey: idempotencyKey
          .optional()
          .describe(
            "Optional. Without it the server derives one from the poster, caption and fields, so an identical retry is a replay.",
          ),
        mediaId: objectId.optional(),
        source: z
          .strictObject({
            type: z.literal("google_drive"),
            imageFileId: driveId,
            captionFileId: driveId.optional(),
            metadataFileId: driveId.optional(),
            folderId: driveId
              .optional()
              .describe("The day's Drive folder; the poster must be in it"),
          })
          .optional(),
        platforms: platforms.optional().describe('Default: ["instagram"]'),
        title: fields.title.optional(),
        caption: fields.caption.optional(),
        altText: fields.altText.optional(),
        notes: fields.notes.optional(),
        scheduledFor: fields.scheduledFor.optional(),
      }),
      output: envelope(
        {
          post: socialPostShape,
          alreadyExists: z.boolean(),
          deduplicatedImage: z.boolean(),
        },
        true,
      ),
      annotations: { ...WRITE, openWorldHint: true },
    },
    (args, ctx) => socialTools.createSocialDraft(args, ctx),
  );

  register(
    "aquakart_update_social_draft",
    {
      title: "Update social post draft",
      description:
        "Edit a draft or rejected social post (caption, title, alt text, notes, platforms, preferred time, or a new poster mediaId). A rejected post returns to draft for another review. Approved and published posts cannot be edited through MCP.",
      scopes: [MCP_SCOPES.socialWrite],
      input: z.strictObject({
        idempotencyKey,
        postId: objectId,
        expectedRevision,
        mediaId: objectId.optional(),
        platforms: platforms.optional(),
        title: fields.title.optional(),
        caption: fields.caption.optional(),
        altText: fields.altText.nullable().optional(),
        notes: fields.notes.nullable().optional(),
        scheduledFor: fields.scheduledFor.nullable().optional(),
      }),
      output: envelope({ post: socialPostShape }, true),
      annotations: WRITE,
    },
    (args, ctx) => socialTools.updateSocialDraft(args, ctx),
  );

  register(
    "aquakart_get_social_draft",
    {
      title: "Get social post",
      description:
        "One social post with its poster URL, caption, status (draft, approved, rejected, publishing, published), review decision, publishing result and checks (readyForReview, problems, warnings). Use it to verify a draft after creating it.",
      scopes: [MCP_SCOPES.socialRead],
      input: z.strictObject({ postId: objectId }),
      output: envelope({ post: socialPostShape }),
      annotations: READ,
    },
    (args) => socialTools.getSocialDraft(args),
  );

  register(
    "aquakart_list_social_drafts",
    {
      title: "List social posts",
      description:
        "Social posts, newest first, filtered by status, platform or title text.",
      scopes: [MCP_SCOPES.socialRead],
      input: z.strictObject({
        status: z
          .enum(["draft", "approved", "rejected", "publishing", "published"])
          .optional(),
        platform: z.enum(["instagram", "facebook"]).optional(),
        query: z.string().max(100).optional(),
        page: z.number().int().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      output: envelope({
        posts: z.array(socialPostShape),
        page: z.number(),
        limit: z.number(),
        total: z.number(),
      }),
      annotations: READ,
    },
    (args) => socialTools.listSocialDrafts(args),
  );

  register(
    "aquakart_publish_social_post",
    {
      title: "Publish approved social post",
      description:
        "Post an APPROVED social post to Instagram (approval happens only in the AQUACRM). Refuses drafts and rejected posts. Repeating it on a published post changes nothing; a failed attempt returns the post to approved and a retry never posts twice. Facebook is not published yet.",
      scopes: [MCP_SCOPES.igPublish],
      input: z.strictObject({ postId: objectId, expectedRevision }),
      output: envelope({
        post: socialPostShape,
        alreadyPublished: z.boolean(),
      }),
      annotations: { ...WRITE, openWorldHint: true },
    },
    (args, ctx) => socialTools.publishSocialPost(args, ctx),
  );
};
