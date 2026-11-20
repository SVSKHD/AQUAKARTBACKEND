import { createHash } from "node:crypto";
import { BlogToolError } from "./errors.js";
import { hashArgs } from "./operations.js";
import { createDriveImporter, versionOf } from "./driveImport.js";
import { downloadTrustedFile } from "./imageInput.js";
import { validateCaption } from "./instagramTools.js";

// Social media drafts (AquaSocialPost) for the daily content automation:
// Claude creates drafts over MCP (from a poster it uploaded, or straight
// from the Aquakart Google Drive folder), staff approve or reject them in
// the CRM, and publishing is a separate explicit action on an approved
// post. Nothing here ever approves a post on behalf of an MCP client.
//
// Reuses: blogTools.storeImage (Cloudinary + SHA-256 de-duplication, the
// poster stays in Aquakart's Cloudinary permanently), driveImport.js (Drive
// folder/type/size checks), instagramTools (temporary Instagram copy,
// container, safe publish, verification and cleanup) and operations.js
// (idempotency). Dependencies are injected for tests.

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const iso = (value) => (value ? new Date(value).toISOString() : null);
const idOf = (value) => (value ? String(value._id || value) : null);
const PLATFORMS = ["instagram", "facebook"];
const MIN_RATIO = 4 / 5;
const MAX_RATIO = 1.91;
const MAX_HISTORY = 40;
const CREATE_TOOL = "aquakart_create_social_draft";
const UPDATE_TOOL = "aquakart_update_social_draft";

export const revisionOf = (post) => {
  const stamp = post?.updatedAt || post?.createdAt;
  return stamp ? new Date(stamp).toISOString() : "0";
};

// Instagram rules when Instagram is a target; otherwise plain text, max
// 5,000 characters.
export const checkCaption = (caption, platforms) => {
  if (platforms.includes("instagram")) return validateCaption(caption);
  const clean = String(caption || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  const problems = [];
  if (!clean) problems.push("Caption is empty");
  if ([...clean].length > 5000)
    problems.push("Caption exceeds 5,000 characters");
  if (/<\s*\/?\s*[a-z][^>]*>/i.test(clean))
    problems.push("Caption must be plain text (no HTML)");
  if (problems.length)
    throw new BlogToolError(
      "INVALID_CAPTION",
      "Caption is not valid",
      problems,
    );
  return clean;
};

const posterProblems = (media, platforms) => {
  const problems = [];
  if (!media?.publicId) {
    problems.push({ check: "image", message: "No poster attached" });
    return problems;
  }
  if (platforms.includes("instagram")) {
    const ratio =
      media.width && media.height ? media.width / media.height : null;
    if (
      !ratio ||
      ratio < MIN_RATIO - 0.005 ||
      ratio > MAX_RATIO + 0.005 ||
      media.width < 320
    )
      problems.push({
        check: "aspectRatio",
        message:
          "Instagram posters must be at least 320px wide with an aspect ratio between 4:5 and 1.91:1",
      });
  }
  return problems;
};

const contentKeyOf = (mediaSha, caption, platforms) =>
  sha256(`${mediaSha}\n${caption}\n${[...platforms].sort().join(",")}`);

// Fields from tool arguments or a Drive metadata file, normalized.
const normalizeFields = (input, { partial }) => {
  const out = {};
  if (input.platforms !== undefined) {
    const list = Array.isArray(input.platforms)
      ? input.platforms
      : [input.platforms];
    const platforms = [
      ...new Set(list.map((p) => String(p).trim().toLowerCase())),
    ];
    if (!platforms.length || platforms.some((p) => !PLATFORMS.includes(p)))
      throw new BlogToolError(
        "VALIDATION_FAILED",
        "platforms must list instagram and/or facebook",
      );
    out.platforms = platforms;
  } else if (!partial) {
    out.platforms = ["instagram"];
  }
  if (input.title !== undefined) {
    const title = String(input.title || "").trim();
    if (title.length < 3 || title.length > 150)
      throw new BlogToolError(
        "VALIDATION_FAILED",
        "title must be 3-150 characters",
      );
    out.title = title;
  } else if (!partial) {
    throw new BlogToolError(
      "VALIDATION_FAILED",
      "A title is required (argument or metadata file)",
    );
  }
  if (input.caption !== undefined) out.caption = String(input.caption ?? "");
  else if (!partial)
    throw new BlogToolError(
      "VALIDATION_FAILED",
      "A caption is required (argument, caption file or metadata file)",
    );
  for (const [key, max] of [
    ["altText", 1000],
    ["notes", 1000],
  ]) {
    if (input[key] !== undefined && input[key] !== null) {
      const value = String(input[key]).trim();
      if (value.length > max)
        throw new BlogToolError(
          "VALIDATION_FAILED",
          `${key} must be at most ${max} characters`,
        );
      out[key] = value;
    } else if (input[key] === null) out[key] = "";
  }
  if (input.scheduledFor !== undefined) {
    if (input.scheduledFor === null || input.scheduledFor === "") {
      out.scheduledFor = null;
    } else {
      const date = new Date(input.scheduledFor);
      if (Number.isNaN(date.getTime()))
        throw new BlogToolError(
          "VALIDATION_FAILED",
          "scheduledFor must be an ISO date-time",
        );
      out.scheduledFor = date;
    }
  }
  return out;
};

export const createSocialTools = ({
  store,
  blogTools,
  instagramTools,
  drive = null,
  runOperation,
  config,
  now = () => new Date(),
  audit = async () => {},
  log = console,
  fetchMediaBytes = (media) =>
    downloadTrustedFile(media.imageUrl, {
      trustedHosts: ["res.cloudinary.com"],
      maxBytes: config.imageMaxBytes,
    }),
}) => {
  const importer = createDriveImporter({ drive, config });
  const event = (status, by, note) => ({
    status,
    at: now(),
    by: by ? String(by) : undefined,
    ...(note ? { note: String(note).slice(0, 300) } : {}),
  });
  const pushHistory = (...events) => ({
    history: { $each: events, $slice: -MAX_HISTORY },
  });
  const logEvent = (fields) => log.log(JSON.stringify(fields));

  const publishView = (entry) =>
    entry?.status
      ? {
          status: entry.status,
          assetId: entry.assetId || null,
          externalId: entry.externalId || null,
          permalink: entry.permalink || null,
          publishedAt: iso(entry.publishedAt),
          lastError: entry.lastError?.code
            ? { code: entry.lastError.code, message: entry.lastError.message }
            : null,
        }
      : null;

  const checksOf = (post) => {
    const problems = posterProblems(post.media, post.platforms || []);
    try {
      checkCaption(post.caption, post.platforms || []);
    } catch (error) {
      problems.push({
        check: "caption",
        message: [error.message, ...(error.details || [])].join(": "),
      });
    }
    const warnings = [];
    if (!post.altText)
      warnings.push({
        check: "altText",
        message: "No alt text; add an accessible image description",
      });
    if (post.platforms?.includes("facebook"))
      warnings.push({
        check: "facebook",
        message:
          "Facebook publishing is not available yet; only Instagram will be posted",
      });
    return { readyForReview: problems.length === 0, problems, warnings };
  };

  const view = (post) => ({
    postId: String(post._id),
    title: post.title,
    platforms: post.platforms || [],
    status: post.status,
    caption: post.caption,
    altText: post.altText || "",
    notes: post.notes || "",
    scheduledFor: iso(post.scheduledFor),
    revision: revisionOf(post),
    image: post.media?.publicId
      ? {
          mediaId: idOf(post.media.mediaId),
          imageUrl: post.media.imageUrl,
          width: post.media.width ?? null,
          height: post.media.height ?? null,
          format: post.media.format || null,
          bytes: post.media.bytes ?? null,
        }
      : null,
    source: {
      type: post.source?.type || "media",
      folderId: post.source?.folderId || null,
      imageFileId: post.source?.imageFileId || null,
      captionFileId: post.source?.captionFileId || null,
      metadataFileId: post.source?.metadataFileId || null,
    },
    review: post.review?.decision
      ? {
          decision: post.review.decision,
          by: idOf(post.review.by),
          at: iso(post.review.at),
          note: post.review.note || "",
        }
      : null,
    publishing: {
      instagram: publishView(post.publishing?.instagram),
      facebook: publishView(post.publishing?.facebook),
    },
    publishedAt: iso(post.publishedAt),
    createdAt: iso(post.createdAt),
    updatedAt: iso(post.updatedAt),
    checks: checksOf(post),
  });

  const loadPost = async (postId) => {
    const post = await store.findSocialPost(postId);
    if (!post)
      throw new BlogToolError(
        "SOCIAL_POST_NOT_FOUND",
        "No social post with that id",
      );
    return post;
  };

  const checkRevision = (post, expectedRevision) => {
    if (expectedRevision && expectedRevision !== revisionOf(post))
      throw new BlogToolError(
        "REVISION_CONFLICT",
        "The post changed since you read it; get it again and retry",
        { currentRevision: revisionOf(post) },
      );
  };

  const mediaSnapshot = (media) => ({
    mediaId: media._id,
    publicId: media.publicId,
    imageUrl: media.secureUrl,
    width: media.width,
    height: media.height,
    format: media.format,
    bytes: media.bytes,
    sha256: media.sha256,
  });

  const activeMedia = async (mediaId) => {
    const media = await store.findMediaById(mediaId);
    if (!media || media.status !== "active")
      throw new BlogToolError(
        "MEDIA_NOT_FOUND",
        "Upload the poster first (aquakart_create_image_upload or aquakart_upload_image) and pass its mediaId",
      );
    return media;
  };

  const assertPoster = (media, platforms) => {
    const problems = posterProblems(media, platforms);
    if (problems.length)
      throw new BlogToolError("INVALID_ASPECT_RATIO", problems[0].message, {
        width: media.width ?? null,
        height: media.height ?? null,
      });
  };

  const audited = (action, ctx, postId, metadata = {}) =>
    audit({
      action,
      adminUserId: ctx.auth.adminUserId,
      resourceType: "social_post",
      resourceId: postId,
      metadata: {
        clientId: ctx.auth.clientId,
        correlationId: ctx.correlationId,
        ...metadata,
      },
    });

  // Edits shared by the MCP update tool and the CRM. MCP may edit drafts
  // and rejected posts; CRM reviewers may also edit approved posts. Any
  // edit puts the post back to draft, so it needs (re-)approval.
  const applyEdit = async (
    post,
    fields,
    ctx,
    { allowApproved, operationId },
  ) => {
    const allowed = [
      "draft",
      "rejected",
      ...(allowApproved ? ["approved"] : []),
    ];
    if (!allowed.includes(post.status))
      throw new BlogToolError(
        "SOCIAL_POST_NOT_EDITABLE",
        `A ${post.status} post cannot be edited${allowApproved ? "" : " through MCP; approved posts are edited in the CRM"}`,
        { status: post.status },
      );
    const { mediaId, ...rest } = fields;
    const changes = normalizeFields(rest, { partial: true });
    const platforms = changes.platforms || post.platforms;
    const caption = checkCaption(
      changes.caption !== undefined ? changes.caption : post.caption,
      platforms,
    );
    let media = null;
    if (mediaId) media = mediaSnapshot(await activeMedia(mediaId));
    const poster = media || post.media;
    assertPoster(poster, platforms);
    const contentKey = contentKeyOf(poster.sha256, caption, platforms);
    if (contentKey !== post.contentKey) {
      const other = await store.findSocialPostByContentKey(contentKey);
      if (other && String(other._id) !== String(post._id))
        throw new BlogToolError(
          "DUPLICATE_SOCIAL_POST",
          "Another post already has this poster, caption and platforms",
          { postId: String(other._id), status: other.status },
        );
    }
    const set = {
      ...changes,
      caption,
      contentKey,
      status: "draft",
      ...(media ? { media } : {}),
      ...(operationId
        ? { "integration.lastUpdatedByOperation": operationId }
        : {}),
    };
    const updated = await store.updateSocialPost(
      String(post._id),
      { status: post.status, updatedAt: post.updatedAt ?? null },
      {
        $set: set,
        $push: pushHistory(
          event(
            "draft",
            ctx.auth.adminUserId,
            `edited (${Object.keys(fields).join(", ")})`,
          ),
        ),
      },
    );
    if (!updated)
      throw new BlogToolError(
        "REVISION_CONFLICT",
        "The post changed while updating; get it again and retry",
      );
    return updated;
  };

  // Drive inputs for a draft: poster metadata (no download yet), caption
  // text and the metadata JSON. Explicit arguments win over file values.
  const readDriveSource = async (source) => {
    const imageFile = await importer.inspectImage(source.imageFileId);
    if (source.folderId && !(imageFile.parents || []).includes(source.folderId))
      throw new BlogToolError(
        "DRIVE_FOLDER_MISMATCH",
        "The poster is not directly inside the given folderId",
      );
    const caption = source.captionFileId
      ? await importer.readText(source.captionFileId)
      : null;
    const metadata = source.metadataFileId
      ? await importer.readJson(source.metadataFileId)
      : null;
    return { imageFile, caption, metadata };
  };

  return {
    view,

    async createSocialDraft(args, ctx) {
      const started = Date.now();
      const usesDrive = Boolean(args.source);
      try {
        if (Boolean(args.mediaId) === usesDrive)
          throw new BlogToolError(
            "VALIDATION_FAILED",
            "Provide exactly one of mediaId or source",
          );
        let drivePart = null;
        if (usesDrive) {
          if (args.source.type !== "google_drive")
            throw new BlogToolError(
              "VALIDATION_FAILED",
              "source.type must be google_drive",
            );
          drivePart = await readDriveSource(args.source);
        }
        const meta = drivePart?.metadata?.data || {};
        const pick = (key) => (args[key] !== undefined ? args[key] : meta[key]);
        const fields = normalizeFields(
          {
            title: pick("title"),
            platforms: pick("platforms"),
            caption:
              args.caption !== undefined
                ? args.caption
                : (drivePart?.caption?.text ?? meta.caption),
            altText: pick("altText"),
            notes: pick("notes"),
            scheduledFor: pick("scheduledFor"),
          },
          { partial: false },
        );
        const caption = checkCaption(fields.caption, fields.platforms);

        const identity = {
          mediaId: args.mediaId,
          imageFileId: drivePart?.imageFile.id,
          imageVersion: drivePart ? versionOf(drivePart.imageFile) : undefined,
          captionHash: sha256(caption),
          title: fields.title,
          platforms: fields.platforms,
          altText: fields.altText,
          notes: fields.notes,
          scheduledFor: fields.scheduledFor
            ? fields.scheduledFor.toISOString()
            : undefined,
        };
        const idempotencyKey =
          args.idempotencyKey ||
          `social-draft:${hashArgs(CREATE_TOOL, identity).slice(0, 48)}`;

        const outcome = await runOperation(
          {
            clientId: ctx.auth.clientId,
            adminUserId: ctx.auth.adminUserId,
            tool: CREATE_TOOL,
            idempotencyKey,
            args: identity,
            correlationId: ctx.correlationId,
          },
          async (operation) => {
            let media;
            let deduplicatedImage = true;
            if (drivePart) {
              const input = await importer.downloadImage(drivePart.imageFile, {
                minWidth: 320,
                minHeight: 320,
                maxDimension: config.bannerMaxDimension,
                label: "Poster",
              });
              const saved = await blogTools.storeImage(input, ctx.auth, {
                operationId: operation.operationId,
                correlationId: ctx.correlationId,
              });
              deduplicatedImage = saved.deduplicated;
              media = await activeMedia(saved.media.mediaId);
            } else {
              media = await activeMedia(args.mediaId);
            }
            assertPoster(media, fields.platforms);

            const contentKey = contentKeyOf(
              media.sha256,
              caption,
              fields.platforms,
            );
            const existing = await store.findSocialPostByContentKey(contentKey);
            if (existing)
              return {
                result: {
                  post: view(existing),
                  alreadyExists: true,
                  deduplicatedImage,
                },
              };
            let created;
            try {
              created = await store.createSocialPost({
                ...fields,
                caption,
                status: "draft",
                media: mediaSnapshot(media),
                source: drivePart
                  ? {
                      type: "google_drive",
                      folderId: args.source.folderId,
                      imageFileId: drivePart.imageFile.id,
                      imageVersion: identity.imageVersion,
                      captionFileId: drivePart.caption?.file.id,
                      captionVersion: drivePart.caption?.version,
                      metadataFileId: drivePart.metadata?.file.id,
                      metadataVersion: drivePart.metadata?.version,
                    }
                  : { type: "media" },
                contentKey,
                integration: {
                  source: "mcp",
                  clientId: ctx.auth.clientId,
                  clientName: ctx.auth.clientName,
                  createdBy: ctx.auth.adminUserId,
                  createdByOperation: operation.operationId,
                },
                history: [event("draft", ctx.auth.adminUserId, "created")],
              });
            } catch (error) {
              if (error?.code !== 11000) throw error;
              const raced = await store.findSocialPostByContentKey(contentKey);
              return {
                result: {
                  post: view(raced),
                  alreadyExists: true,
                  deduplicatedImage,
                },
              };
            }
            await audited("mcp.social.create", ctx, created._id, {
              operationId: operation.operationId,
              mediaId: String(media._id),
              driveImageFileId: drivePart?.imageFile.id,
            });
            return {
              result: {
                post: view(created),
                alreadyExists: false,
                deduplicatedImage,
              },
            };
          },
        );
        logEvent({
          event: "mcp.social.create",
          correlationId: ctx.correlationId,
          clientId: ctx.auth.clientId,
          ok: true,
          postId: outcome.result.post.postId,
          alreadyExists: outcome.result.alreadyExists,
          replayed: outcome.replayed,
          durationMs: Date.now() - started,
        });
        return {
          ...outcome.result,
          operationId: outcome.operationId,
          replayed: outcome.replayed,
        };
      } catch (error) {
        logEvent({
          event: "mcp.social.create",
          correlationId: ctx.correlationId,
          clientId: ctx.auth.clientId,
          ok: false,
          code: error?.code || "INTERNAL_ERROR",
          durationMs: Date.now() - started,
        });
        throw error;
      }
    },

    async updateSocialDraft(args, ctx) {
      const { postId, expectedRevision, idempotencyKey, ...fields } = args;
      if (!Object.values(fields).some((value) => value !== undefined))
        throw new BlogToolError("VALIDATION_FAILED", "No fields to update");
      const outcome = await runOperation(
        {
          clientId: ctx.auth.clientId,
          adminUserId: ctx.auth.adminUserId,
          tool: UPDATE_TOOL,
          idempotencyKey,
          args,
          correlationId: ctx.correlationId,
        },
        async (operation) => {
          const post = await loadPost(postId);
          checkRevision(post, expectedRevision);
          const updated = await applyEdit(post, fields, ctx, {
            allowApproved: false,
            operationId: operation.operationId,
          });
          await audited("mcp.social.update", ctx, postId, {
            operationId: operation.operationId,
            fields: Object.keys(fields),
          });
          return { result: { post: view(updated) } };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    async getSocialDraft({ postId }) {
      return { post: view(await loadPost(postId)) };
    },

    async listSocialDrafts({ status, platform, query, page = 1, limit = 20 }) {
      const { items, total } = await store.listSocialPosts({
        status,
        platform,
        query,
        skip: (page - 1) * limit,
        limit,
      });
      return { posts: items.map(view), page, limit, total };
    },

    // CRM edit (reviewers): same rules as the MCP update, plus approved
    // posts, which go back to draft.
    async editSocialPost({ postId, expectedRevision, ...fields }, ctx) {
      if (!Object.values(fields).some((value) => value !== undefined))
        throw new BlogToolError("VALIDATION_FAILED", "No fields to update");
      const post = await loadPost(postId);
      checkRevision(post, expectedRevision);
      const updated = await applyEdit(post, fields, ctx, {
        allowApproved: true,
      });
      await audited("crm.social.update", ctx, postId, {
        fields: Object.keys(fields),
      });
      return { post: view(updated) };
    },

    // CRM approve/reject. Only people can approve; there is no MCP tool.
    async reviewSocialPost({ postId, decision, note, expectedRevision }, ctx) {
      if (!["approved", "rejected"].includes(decision))
        throw new BlogToolError(
          "VALIDATION_FAILED",
          "decision must be approved or rejected",
        );
      const post = await loadPost(postId);
      checkRevision(post, expectedRevision);
      const from = decision === "approved" ? ["draft"] : ["draft", "approved"];
      if (!from.includes(post.status))
        throw new BlogToolError(
          "INVALID_STATUS",
          `A ${post.status} post cannot be ${decision}`,
          { status: post.status },
        );
      if (decision === "approved") {
        const { problems } = checksOf(post);
        if (problems.length)
          throw new BlogToolError(
            "SOCIAL_POST_NOT_READY",
            "Fix the listed problems before approving",
            problems,
          );
      }
      if (decision === "rejected" && !String(note || "").trim())
        throw new BlogToolError(
          "VALIDATION_FAILED",
          "Give a reason when rejecting a post",
        );
      const updated = await store.updateSocialPost(
        postId,
        { status: post.status, updatedAt: post.updatedAt ?? null },
        {
          $set: {
            status: decision,
            review: {
              decision,
              by: ctx.auth.adminUserId,
              at: now(),
              note: String(note || "")
                .trim()
                .slice(0, 1000),
            },
          },
          $push: pushHistory(event(decision, ctx.auth.adminUserId, note)),
        },
      );
      if (!updated)
        throw new BlogToolError(
          "REVISION_CONFLICT",
          "The post changed while reviewing; reload and retry",
        );
      await audited(
        `crm.social.${decision === "approved" ? "approve" : "reject"}`,
        ctx,
        postId,
      );
      return { post: view(updated) };
    },

    // Publishes an APPROVED post to Instagram (CRM button or the MCP tool).
    // The permanent poster is copied to Instagram's temporary folder by
    // instagramTools, which owns container creation, the never-twice
    // publish, verification and cleanup. Facebook is recorded as
    // unsupported. A failure returns the post to approved for a retry;
    // retries reuse the same Instagram operations, so an uncertain earlier
    // attempt is reconciled with Meta instead of posting twice.
    async publishSocialPost({ postId, expectedRevision }, ctx) {
      const started = Date.now();
      let post = await loadPost(postId);
      if (post.status === "published")
        return { post: view(post), alreadyPublished: true };
      if (!post.platforms.includes("instagram"))
        throw new BlogToolError(
          "PLATFORM_NOT_SUPPORTED",
          "Only Instagram publishing is available; Facebook is not set up yet",
        );
      if (!config.instagram?.configured)
        throw new BlogToolError(
          "INSTAGRAM_NOT_CONFIGURED",
          "Instagram publishing is not configured on this server",
        );
      checkRevision(post, expectedRevision);
      const lockedUntil = new Date(now().getTime() + config.operationLockMs);
      const claimed = await store.updateSocialPost(
        postId,
        {
          $or: [
            { status: "approved" },
            { status: "publishing", "publishing.lockedUntil": { $lt: now() } },
          ],
        },
        {
          $set: {
            status: "publishing",
            "publishing.lockedUntil": lockedUntil,
            "publishing.requestedBy": ctx.auth.adminUserId,
            "publishing.instagram.status": "pending",
          },
          $push: pushHistory(event("publishing", ctx.auth.adminUserId)),
        },
      );
      if (!claimed) {
        post = await loadPost(postId);
        if (post.status === "published")
          return { post: view(post), alreadyPublished: true };
        if (post.status === "publishing")
          throw Object.assign(
            new BlogToolError(
              "PUBLISH_IN_PROGRESS",
              "This post is being published right now",
            ),
            { retryable: true },
          );
        throw new BlogToolError(
          "SOCIAL_POST_NOT_APPROVED",
          "Only approved posts can be published; approve it in the CRM first",
          { status: post.status },
        );
      }
      post = claimed;
      const tag = `${postId}-${sha256(`${post.media.sha256}\n${post.caption}\n${post.altText || ""}`).slice(0, 16)}`;
      try {
        const bytes = await fetchMediaBytes(post.media);
        const upload = await instagramTools.uploadInstagramImage(
          {
            idempotencyKey: `social-ig-upload-${tag}`,
            imageBase64: bytes.toString("base64"),
          },
          ctx,
        );
        const published = await instagramTools.publishInstagram(
          {
            idempotencyKey: `social-ig-publish-${tag}`,
            assetId: upload.asset.assetId,
            caption: post.caption,
            ...(post.altText ? { altText: post.altText } : {}),
          },
          ctx,
        );
        const asset = published.asset;
        const at = asset.publishedAt ? new Date(asset.publishedAt) : now();
        const done = await store.updateSocialPost(
          postId,
          { status: "publishing" },
          {
            $set: {
              status: "published",
              publishedAt: at,
              "publishing.lockedUntil": null,
              "publishing.instagram": {
                status: "published",
                assetId: asset.assetId,
                externalId: asset.instagramMediaId,
                permalink: asset.permalink,
                publishedAt: at,
              },
              ...(post.platforms.includes("facebook")
                ? { "publishing.facebook": { status: "unsupported" } }
                : {}),
            },
            $push: pushHistory(event("published", ctx.auth.adminUserId)),
          },
        );
        await audited("social.publish", ctx, postId, {
          instagramMediaId: asset.instagramMediaId,
          assetId: asset.assetId,
        });
        logEvent({
          event: "social.publish",
          correlationId: ctx.correlationId,
          clientId: ctx.auth.clientId,
          postId,
          ok: true,
          instagramMediaId: asset.instagramMediaId,
          durationMs: Date.now() - started,
        });
        return {
          post: view(done || (await loadPost(postId))),
          alreadyPublished: Boolean(published.alreadyPublished),
        };
      } catch (caught) {
        const code = caught?.code || "INTERNAL_ERROR";
        await store
          .updateSocialPost(
            postId,
            { status: "publishing" },
            {
              $set: {
                status: "approved",
                "publishing.lockedUntil": null,
                "publishing.instagram.status": "failed",
                "publishing.instagram.lastError": {
                  code,
                  message:
                    caught instanceof BlogToolError
                      ? caught.message
                      : "Publishing failed",
                  at: now(),
                },
              },
              $push: pushHistory(
                event(
                  "approved",
                  ctx.auth.adminUserId,
                  `publish failed: ${code}`,
                ),
              ),
            },
          )
          .catch(() => {});
        logEvent({
          event: "social.publish",
          correlationId: ctx.correlationId,
          clientId: ctx.auth.clientId,
          postId,
          ok: false,
          code,
          durationMs: Date.now() - started,
        });
        throw caught;
      }
    },
  };
};
