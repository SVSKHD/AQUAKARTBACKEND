import { createHash, randomUUID } from "node:crypto";
import { BlogToolError } from "./errors.js";
import { INSTAGRAM_TEMP_FOLDER } from "./config.js";
import { readImageInput } from "./imageInput.js";

// Instagram publishing behind the Aquakart MCP tools, with temporary
// Cloudinary storage that is deleted only after Meta's publication has been
// verified (plus a safety delay). Dependencies are injected so every state
// transition is unit-tested against mocked Meta/Cloudinary/MongoDB.
//
// Safety rules:
// - one record per image (sha256): the same creative can't be posted twice
// - media_publish is never repeated while its outcome is unknown; a lost
//   response is reconciled with Meta first (PUBLISH_UNCERTAIN)
// - cleanup needs PUBLISHED_VERIFIED, a passed cleanupAfter, a recheck, and
//   a public id inside aquakart/instagram-temp/ that matches the record
// - deleting an already-missing image counts as cleaned (crash recovery)

export const TEMP_PUBLIC_ID = /^aquakart\/instagram-temp\/ig_[a-f0-9]{32}$/;
const PUBLISHED_STATES = ["PUBLISHED_VERIFIED", "CLEANUP_PENDING", "CLEANED"];
const PUBLISHABLE_STATES = [
  "UPLOADED",
  "CONTAINER_CREATED",
  "PROCESSING",
  "READY",
  "FAILED",
];
const MIN_RATIO = 4 / 5;
const MAX_RATIO = 1.91;
const MAX_HISTORY = 40;

export const isTempPublicId = (publicId) =>
  typeof publicId === "string" && TEMP_PUBLIC_ID.test(publicId);

export const validateCaption = (caption) => {
  // Instagram limits: 2,200 characters, 30 hashtags, 20 @mentions.
  const clean = String(caption || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  const problems = [];
  if (!clean) problems.push("Caption is empty");
  if ([...clean].length > 2200)
    problems.push("Caption exceeds 2,200 characters");
  if ((clean.match(/(^|\s)#[^\s#]+/g) || []).length > 30)
    problems.push("Caption has more than 30 hashtags");
  if ((clean.match(/(^|\s)@[A-Za-z0-9._]+/g) || []).length > 20)
    problems.push("Caption has more than 20 @mentions");
  if (/<\s*\/?\s*[a-z][^>]*>/i.test(clean))
    problems.push("Caption must be plain text (no HTML)");
  if (problems.length) {
    throw new BlogToolError(
      "INVALID_CAPTION",
      "Caption is not valid for Instagram",
      problems,
    );
  }
  return clean;
};

const hashText = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const iso = (value) => (value ? new Date(value).toISOString() : null);

export const createInstagramTools = ({
  store,
  uploader,
  graph,
  runOperation,
  config,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  audit = async () => {},
}) => {
  const ig = config.instagram;
  const event = (status, note) => ({
    status,
    at: now(),
    ...(note ? { note } : {}),
  });
  const push = (...events) => ({
    history: { $each: events, $slice: -MAX_HISTORY },
  });

  const view = (asset) => ({
    assetId: asset.assetId,
    status: asset.status,
    cloudinaryPublicId: asset.cloudinaryPublicId,
    imageUrl: asset.status === "CLEANED" ? null : asset.deliveryUrl,
    width: asset.width ?? null,
    height: asset.height ?? null,
    caption: asset.caption ?? null,
    instagramMediaId: asset.instagramMediaId ?? null,
    permalink: asset.permalink ?? null,
    publishedAt: iso(asset.publishedAt),
    verifiedAt: iso(asset.verifiedAt),
    cleanupStatus: asset.cleanupStatus || "none",
    cleanupAfter: iso(asset.cleanupAfter),
    cleanedAt: iso(asset.cleanedAt),
    lastError: asset.lastError?.code
      ? { code: asset.lastError.code, message: asset.lastError.message }
      : null,
    createdAt: iso(asset.createdAt),
  });

  const loadAsset = async (assetId) => {
    const asset = await store.findAsset(assetId);
    if (!asset)
      throw new BlogToolError(
        "ASSET_NOT_FOUND",
        "No Instagram asset with that id",
      );
    return asset;
  };

  const requireConfigured = () => {
    if (!ig.configured) {
      throw new BlogToolError(
        "INSTAGRAM_NOT_CONFIGURED",
        "Instagram publishing is not configured on the server",
      );
    }
  };

  const update = (assetId, condition, change) =>
    store.updateAsset(assetId, condition, change);

  const errorInfo = (error) => ({
    code: error.code || "INTERNAL_ERROR",
    message: String(error.message).slice(0, 300),
    at: now(),
  });

  // Records verified publication and the cleanup requirement in ONE write,
  // before any success is reported.
  const markVerified = async (asset, media) => {
    const at = now();
    const updated = await update(
      asset.assetId,
      { status: { $nin: ["CLEANUP_PENDING", "CLEANED"] } },
      {
        $set: {
          status: "CLEANUP_PENDING",
          instagramMediaId: media.id,
          permalink: media.permalink || null,
          publishedAt: media.timestamp ? new Date(media.timestamp) : at,
          verifiedAt: at,
          cleanupStatus: "pending",
          cleanupAfter: new Date(at.getTime() + ig.cleanupDelayMs),
          cleanupNextAttemptAt: null,
          cleanupAttempts: 0,
          publishLockedUntil: null,
          lastError: null,
        },
        $push: push(
          event("PUBLISHED_VERIFIED", media.id),
          event("CLEANUP_PENDING"),
        ),
      },
    );
    return updated || store.findAsset(asset.assetId);
  };

  // Works out what happened on Meta without publishing anything.
  // Returns { outcome: "published" | "not_published" | "unknown", asset }.
  const reconcile = async (asset) => {
    try {
      if (asset.instagramMediaId) {
        const media = await graph.getMedia(asset.instagramMediaId);
        if (media?.id === asset.instagramMediaId) {
          return {
            outcome: "published",
            asset: await markVerified(asset, media),
          };
        }
        return { outcome: "unknown", asset };
      }
      if (!asset.containerId) {
        return {
          outcome: "not_published",
          asset: await update(
            asset.assetId,
            {},
            { $set: { status: "UPLOADED" } },
          ),
        };
      }
      const container = await graph.getContainer(asset.containerId);
      const code = container?.status_code;
      if (code === "PUBLISHED") {
        const since = new Date(
          (asset.publishAttemptAt
            ? new Date(asset.publishAttemptAt)
            : now()
          ).getTime() -
            10 * 60000,
        );
        const match = (await graph.recentMedia(25)).find(
          (item) =>
            (item.caption || "").trim() === (asset.caption || "").trim() &&
            new Date(item.timestamp) >= since,
        );
        if (!match) return { outcome: "unknown", asset };
        const media = await graph.getMedia(match.id);
        return {
          outcome: "published",
          asset: await markVerified(asset, media),
        };
      }
      if (code === "FINISHED") {
        return {
          outcome: "not_published",
          asset: await update(
            asset.assetId,
            {},
            {
              $set: { status: "READY", containerStatus: code },
              $push: push(event("READY", "reconciled")),
            },
          ),
        };
      }
      if (code === "IN_PROGRESS") {
        return {
          outcome: "not_published",
          asset: await update(
            asset.assetId,
            {},
            { $set: { status: "PROCESSING", containerStatus: code } },
          ),
        };
      }
      if (code === "ERROR" || code === "EXPIRED") {
        return {
          outcome: "not_published",
          asset: await update(
            asset.assetId,
            {},
            {
              $set: {
                status: "FAILED",
                containerId: null,
                containerStatus: code,
                lastError: {
                  code: `CONTAINER_${code}`,
                  message: container?.status || code,
                  at: now(),
                },
              },
              $push: push(event("FAILED", `container ${code}`)),
            },
          ),
        };
      }
      return { outcome: "unknown", asset };
    } catch (error) {
      if (
        error?.code === "META_NOT_FOUND" &&
        !asset.instagramMediaId &&
        asset.containerId
      ) {
        // The container is gone (expired), so it was never published from here.
        return {
          outcome: "not_published",
          asset: await update(
            asset.assetId,
            {},
            {
              $set: {
                status: "FAILED",
                containerId: null,
                containerStatus: "EXPIRED",
              },
            },
          ),
        };
      }
      return { outcome: "unknown", asset };
    }
  };

  const pollContainer = async (asset) => {
    let current = asset;
    for (let attempt = 0; attempt < ig.containerPollAttempts; attempt += 1) {
      const container = await graph.getContainer(current.containerId);
      const code = container?.status_code;
      if (code === "FINISHED") {
        return update(
          current.assetId,
          {},
          {
            $set: { status: "READY", containerStatus: code },
            $push: push(event("READY")),
          },
        );
      }
      if (code === "PUBLISHED")
        return {
          ...current,
          containerStatus: code,
          alreadyPublishedContainer: true,
        };
      if (code === "ERROR" || code === "EXPIRED") {
        await update(
          current.assetId,
          {},
          {
            $set: {
              status: "FAILED",
              containerId: null,
              containerStatus: code,
              lastError: {
                code: `CONTAINER_${code}`,
                message: String(container?.status || code).slice(0, 300),
                at: now(),
              },
            },
            $push: push(event("FAILED", `container ${code}`)),
          },
        );
        throw Object.assign(
          new BlogToolError(
            "CONTAINER_FAILED",
            `Instagram could not process the image (${code})`,
            { status: container?.status },
          ),
          { retryable: true },
        );
      }
      if (current.status !== "PROCESSING") {
        current =
          (await update(
            current.assetId,
            {},
            {
              $set: { status: "PROCESSING", containerStatus: code },
              $push: push(event("PROCESSING")),
            },
          )) || current;
      }
      if (attempt < ig.containerPollAttempts - 1)
        await sleep(ig.containerPollIntervalMs);
    }
    throw Object.assign(
      new BlogToolError(
        "CONTAINER_PROCESSING",
        "Instagram is still processing the image; call aquakart_publish_instagram again shortly",
      ),
      { retryable: true },
    );
  };

  const publishFlow = async (asset, caption, altText, operation) => {
    let current = asset;
    const captionHash = hashText(`${caption}\n${altText || ""}`);
    if (
      !current.containerId ||
      current.captionHash !== captionHash ||
      current.status === "FAILED"
    ) {
      const containerId = await graph.createContainer({
        imageUrl: current.deliveryUrl,
        caption,
        altText,
      });
      current = await update(
        current.assetId,
        {},
        {
          $set: {
            status: "CONTAINER_CREATED",
            containerId,
            containerStatus: null,
            caption,
            captionHash,
            altText: altText || null,
          },
          $push: push(event("CONTAINER_CREATED", containerId)),
        },
      );
    }
    if (current.status !== "READY") current = await pollContainer(current);
    if (current.alreadyPublishedContainer) {
      const result = await reconcile({
        ...current,
        publishAttemptAt: current.publishAttemptAt || now(),
      });
      if (result.outcome === "published") return result.asset;
      throw Object.assign(
        new BlogToolError(
          "PUBLISH_UNCERTAIN",
          "Instagram reports this container as published; reconciling",
        ),
        { retryable: true },
      );
    }

    // Persist the attempt BEFORE calling Meta, so a crash or lost response
    // is recognisable and reconciled instead of re-published.
    current = await update(
      current.assetId,
      {},
      {
        $set: {
          status: "PUBLISHING",
          publishAttemptAt: now(),
          publishOperationId: operation.operationId,
        },
        $inc: { publishAttempts: 1 },
        $push: push(event("PUBLISHING")),
      },
    );

    let mediaId;
    try {
      mediaId = await graph.publishContainer(current.containerId);
    } catch (error) {
      if (
        error?.code === "META_RATE_LIMITED" ||
        error?.code === "INSTAGRAM_TOKEN_INVALID" ||
        error?.code === "META_REQUEST_REJECTED"
      ) {
        // Meta refused outright: nothing was published.
        await update(
          current.assetId,
          {},
          {
            $set: { status: "READY", lastError: errorInfo(error) },
            $push: push(event("READY", error.code)),
          },
        );
        throw error;
      }
      await update(
        current.assetId,
        {},
        {
          $set: { status: "PUBLISH_UNCERTAIN", lastError: errorInfo(error) },
          $push: push(event("PUBLISH_UNCERTAIN", error?.code)),
        },
      );
      const result = await reconcile({
        ...current,
        status: "PUBLISH_UNCERTAIN",
      });
      if (result.outcome === "published") return result.asset;
      throw Object.assign(
        new BlogToolError(
          "PUBLISH_UNCERTAIN",
          result.outcome === "not_published"
            ? "Meta did not confirm the post and it was not published; retry with the same idempotencyKey"
            : "Meta did not confirm the post; its outcome is being reconciled. Check aquakart_get_instagram_status before retrying",
          { reconciled: result.outcome },
        ),
        { retryable: true },
      );
    }

    // Record the media id first so a failed verification is reconcilable.
    current = await update(
      current.assetId,
      {},
      { $set: { instagramMediaId: mediaId } },
    );
    let media;
    try {
      media = await graph.getMedia(mediaId);
    } catch (error) {
      await update(
        current.assetId,
        {},
        {
          $set: { status: "PUBLISH_UNCERTAIN", lastError: errorInfo(error) },
          $push: push(event("PUBLISH_UNCERTAIN", "verify failed")),
        },
      );
      throw Object.assign(
        new BlogToolError(
          "PUBLISH_UNVERIFIED",
          "Posted, but Instagram has not confirmed the media yet; check status shortly",
          { instagramMediaId: mediaId },
        ),
        { retryable: true },
      );
    }
    if (media?.id !== mediaId) {
      await update(
        current.assetId,
        {},
        { $set: { status: "PUBLISH_UNCERTAIN" } },
      );
      throw Object.assign(
        new BlogToolError(
          "PUBLISH_UNVERIFIED",
          "Instagram returned a different media record",
          { instagramMediaId: mediaId },
        ),
        { retryable: true },
      );
    }
    try {
      return await markVerified(current, media);
    } catch (_error) {
      throw Object.assign(
        new BlogToolError(
          "STORAGE_UNAVAILABLE",
          "Posted and verified, but saving the result failed; retry to record it",
          { instagramMediaId: mediaId },
        ),
        { retryable: true },
      );
    }
  };

  // Deletes the temporary image. `manual` allows never-published uploads.
  const performCleanup = async (asset, { manual = false } = {}) => {
    const fail = async (status, message) => {
      await update(
        asset.assetId,
        {},
        {
          $set: {
            cleanupStatus: status,
            cleanupError: message,
            cleanupLockedUntil: null,
          },
        },
      );
      return { cleaned: false, reason: message, cleanupStatus: status };
    };
    if (!isTempPublicId(asset.cloudinaryPublicId)) {
      return fail(
        "blocked",
        "Public id is outside aquakart/instagram-temp/; refusing to delete",
      );
    }
    const verified =
      asset.status === "CLEANUP_PENDING" &&
      asset.instagramMediaId &&
      asset.verifiedAt;
    const abandoned =
      manual &&
      ["UPLOADED", "FAILED"].includes(asset.status) &&
      !asset.instagramMediaId &&
      !asset.containerId;
    if (!verified && !abandoned) {
      return fail(
        asset.cleanupStatus === "pending"
          ? "pending"
          : asset.cleanupStatus || "none",
        "Asset is not eligible for cleanup",
      );
    }
    if (verified && ig.cleanupVerifyRemote) {
      try {
        const media = await graph.getMedia(asset.instagramMediaId);
        if (media?.id !== asset.instagramMediaId)
          return fail("blocked", "Instagram media did not match the record");
      } catch (error) {
        if (error?.code === "META_NOT_FOUND")
          return fail(
            "blocked",
            "Instagram post no longer exists; kept for manual review",
          );
        return scheduleRetry(asset, error);
      }
    }
    let result;
    try {
      result = await uploader.destroyTemp(asset.cloudinaryPublicId);
    } catch (error) {
      return scheduleRetry(asset, error);
    }
    if (result?.result !== "ok" && result?.result !== "not found") {
      return scheduleRetry(
        asset,
        new Error(`Cloudinary answered ${result?.result || "unknown"}`),
      );
    }
    const cleaned = await update(
      asset.assetId,
      {},
      {
        $set: {
          status: "CLEANED",
          cleanupStatus: "done",
          cleanedAt: now(),
          cleanupLockedUntil: null,
          cleanupError: null,
        },
        $push: push(
          event(
            "CLEANED",
            result.result === "not found" ? "already absent" : undefined,
          ),
        ),
      },
    );
    await audit({
      action: "mcp.instagram.cleanup",
      adminUserId: asset.adminUser,
      resourceType: "instagram_asset",
      resourceId: asset.assetId,
      metadata: {
        publicId: asset.cloudinaryPublicId,
        manual,
        alreadyAbsent: result.result === "not found",
      },
    });
    return {
      cleaned: true,
      alreadyAbsent: result.result === "not found",
      asset: cleaned,
    };
  };

  async function scheduleRetry(asset, error) {
    const attempts = (asset.cleanupAttempts || 0) + 1;
    const exhausted = attempts >= ig.cleanupMaxAttempts;
    const delay = Math.min(60000 * 2 ** (attempts - 1), 3600000);
    await update(
      asset.assetId,
      {},
      {
        $set: {
          cleanupStatus: exhausted ? "failed" : "pending",
          cleanupAttempts: attempts,
          cleanupNextAttemptAt: exhausted
            ? null
            : new Date(now().getTime() + delay),
          cleanupError: String(error?.message || error).slice(0, 300),
          cleanupLockedUntil: null,
        },
      },
    );
    console.error(
      `Instagram temp cleanup failed for ${asset.assetId} (attempt ${attempts}):`,
      String(error?.message || error).slice(0, 200),
    );
    return {
      cleaned: false,
      reason: "Cleanup failed; will retry",
      cleanupStatus: exhausted ? "failed" : "pending",
      attempts,
    };
  }

  const run = (ctx, tool, args, execute) =>
    runOperation(
      {
        clientId: ctx.auth.clientId,
        adminUserId: ctx.auth.adminUserId,
        tool,
        idempotencyKey: args.idempotencyKey,
        args,
        correlationId: ctx.correlationId,
      },
      execute,
    );

  return {
    reconcile,
    performCleanup,

    async uploadInstagramImage(args, ctx) {
      const identity = {
        idempotencyKey: args.idempotencyKey,
        file: args.image ? args.image.file_id : undefined,
        base64: args.imageBase64 ? hashText(args.imageBase64) : undefined,
      };
      const outcome = await run(
        ctx,
        "aquakart_upload_instagram_image",
        identity,
        async (operation) => {
          const input = await readImageInput(args, {
            maxBytes: ig.imageMaxBytes,
            trustedHosts: config.trustedFileHosts,
            download: uploader.download,
          });
          const existing = await store.findAssetBySha(input.sha256);
          if (existing && existing.status !== "CLEANED")
            return { result: { asset: view(existing), deduplicated: true } };
          if (existing?.instagramMediaId) {
            throw new BlogToolError(
              "ALREADY_POSTED",
              "This exact image was already posted to Instagram",
              {
                assetId: existing.assetId,
                instagramMediaId: existing.instagramMediaId,
                permalink: existing.permalink || null,
              },
            );
          }
          const publicId = `${INSTAGRAM_TEMP_FOLDER}/ig_${input.sha256.slice(0, 32)}`;
          const uploaded = await uploader.uploadTemp(input.buffer, {
            publicId,
          });
          if (uploaded.public_id !== publicId) {
            throw new BlogToolError(
              "STORAGE_UNAVAILABLE",
              "Cloudinary stored the image under an unexpected id",
            );
          }
          const ratio =
            uploaded.width && uploaded.height
              ? uploaded.width / uploaded.height
              : null;
          if (
            !ratio ||
            ratio < MIN_RATIO - 0.005 ||
            ratio > MAX_RATIO + 0.005 ||
            uploaded.width < 320
          ) {
            await uploader.destroyTemp(publicId).catch(() => {});
            throw new BlogToolError(
              "INVALID_ASPECT_RATIO",
              "Instagram images must be at least 320px wide with an aspect ratio between 4:5 and 1.91:1",
              {
                width: uploaded.width ?? null,
                height: uploaded.height ?? null,
              },
            );
          }
          const doc = {
            sha256: input.sha256,
            cloudinaryPublicId: publicId,
            secureUrl: uploaded.secure_url,
            deliveryUrl: uploader.jpegUrl(publicId),
            format: uploaded.format || input.type.format,
            bytes: uploaded.bytes || input.buffer.length,
            width: uploaded.width,
            height: uploaded.height,
            source: input.source,
            clientId: ctx.auth.clientId,
            adminUser: ctx.auth.adminUserId,
            status: "UPLOADED",
            cleanupStatus: "none",
            cleanupAfter: null,
            instagramMediaId: null,
            publishedAt: null,
          };
          let asset;
          if (existing) {
            // Re-upload of a creative whose earlier copy was cleaned unposted.
            asset = await update(
              existing.assetId,
              { status: "CLEANED" },
              {
                $set: {
                  ...doc,
                  containerId: null,
                  caption: null,
                  captionHash: null,
                  cleanedAt: null,
                  cleanupAttempts: 0,
                },
                $push: push(event("UPLOADED", "re-uploaded")),
              },
            );
          } else {
            try {
              asset = await store.createAsset({
                ...doc,
                assetId: `iga_${randomUUID()}`,
                history: [event("UPLOADED")],
              });
            } catch (error) {
              if (error?.code !== 11000) throw error;
              asset = await store.findAssetBySha(input.sha256);
              return { result: { asset: view(asset), deduplicated: true } };
            }
          }
          await audit({
            action: "mcp.instagram.upload",
            adminUserId: ctx.auth.adminUserId,
            resourceType: "instagram_asset",
            resourceId: asset.assetId,
            metadata: {
              clientId: ctx.auth.clientId,
              operationId: operation.operationId,
              correlationId: ctx.correlationId,
            },
          });
          return { result: { asset: view(asset), deduplicated: false } };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    async publishInstagram(args, ctx) {
      requireConfigured();
      const caption = validateCaption(args.caption);
      const altText = args.altText ? String(args.altText).trim() : undefined;
      const outcome = await run(
        ctx,
        "aquakart_publish_instagram",
        args,
        async (operation) => {
          let asset = await loadAsset(args.assetId);
          if (
            PUBLISHED_STATES.includes(asset.status) &&
            asset.instagramMediaId
          ) {
            return { result: { asset: view(asset), alreadyPublished: true } };
          }
          if (asset.status === "CLEANED") {
            throw new BlogToolError(
              "ASSET_CLEANED",
              "The temporary image was deleted; upload it again",
            );
          }
          if (
            asset.status === "PUBLISHING" &&
            asset.publishLockedUntil &&
            new Date(asset.publishLockedUntil) > now()
          ) {
            throw Object.assign(
              new BlogToolError(
                "PUBLISH_IN_PROGRESS",
                "This asset is being published right now",
              ),
              { retryable: true },
            );
          }
          if (
            asset.status === "PUBLISH_UNCERTAIN" ||
            asset.status === "PUBLISHING"
          ) {
            const result = await reconcile(asset);
            if (result.outcome === "published")
              return {
                result: { asset: view(result.asset), alreadyPublished: true },
              };
            if (result.outcome === "unknown") {
              throw Object.assign(
                new BlogToolError(
                  "PUBLISH_UNCERTAIN",
                  "An earlier publish of this asset may have succeeded; not retrying until Meta confirms",
                ),
                { retryable: true },
              );
            }
            asset = result.asset;
          }
          // Reaching here means no earlier attempt was published (reconciled
          // above), so a new caption safely gets a fresh container.
          const locked = await update(
            asset.assetId,
            {
              status: { $in: PUBLISHABLE_STATES },
              $or: [
                { publishLockedUntil: null },
                { publishLockedUntil: { $lt: now() } },
              ],
            },
            {
              $set: {
                publishLockedUntil: new Date(
                  now().getTime() + config.operationLockMs,
                ),
              },
            },
          );
          if (!locked) {
            throw Object.assign(
              new BlogToolError(
                "PUBLISH_IN_PROGRESS",
                "This asset is being published right now",
              ),
              { retryable: true },
            );
          }
          let published;
          try {
            published = await publishFlow(locked, caption, altText, operation);
          } finally {
            await update(
              asset.assetId,
              { status: { $ne: "PUBLISHING" } },
              { $set: { publishLockedUntil: null } },
            ).catch(() => {});
          }
          await audit({
            action: "mcp.instagram.publish",
            adminUserId: ctx.auth.adminUserId,
            resourceType: "instagram_asset",
            resourceId: asset.assetId,
            metadata: {
              clientId: ctx.auth.clientId,
              operationId: operation.operationId,
              correlationId: ctx.correlationId,
              instagramMediaId: published.instagramMediaId,
            },
          });
          return {
            result: { asset: view(published), alreadyPublished: false },
          };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    async getInstagramStatus({ assetId }) {
      return { asset: view(await loadAsset(assetId)) };
    },

    async listInstagramPosts({ status, page = 1, limit = 20 }) {
      const { items, total } = await store.listAssets({
        status,
        skip: (page - 1) * limit,
        limit,
      });
      return { assets: items.map(view), page, limit, total };
    },

    async cleanupInstagramAsset(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_cleanup_instagram_asset",
        args,
        async () => {
          const asset = await loadAsset(args.assetId);
          if (asset.status === "CLEANED")
            return {
              result: {
                asset: view(asset),
                cleaned: true,
                alreadyCleaned: true,
              },
            };
          const result = await performCleanup(asset, { manual: true });
          if (!result.cleaned) {
            throw new BlogToolError(
              result.reason === "Asset is not eligible for cleanup"
                ? "CLEANUP_NOT_ALLOWED"
                : "CLEANUP_FAILED",
              result.reason === "Asset is not eligible for cleanup"
                ? `Cleanup is only allowed after verified publication or for never-published uploads (status ${asset.status})`
                : result.reason,
            );
          }
          return {
            result: {
              asset: view(result.asset),
              cleaned: true,
              alreadyCleaned: false,
            },
          };
        },
      );
      return {
        ...outcome.result,
        operationId: outcome.operationId,
        replayed: outcome.replayed,
      };
    },

    // One pass of the durable cleanup/reconcile worker.
    async runMaintenancePass({ maxItems = 20 } = {}) {
      const summary = { cleaned: 0, retried: 0, blocked: 0, reconciled: 0 };
      for (let index = 0; index < maxItems; index += 1) {
        const asset = await store.claimDueCleanup(
          now(),
          new Date(now().getTime() + 5 * 60000),
        );
        if (!asset) break;
        const result = await performCleanup(asset);
        if (result.cleaned) summary.cleaned += 1;
        else if (result.cleanupStatus === "blocked") summary.blocked += 1;
        else summary.retried += 1;
      }
      for (const asset of await store.findAssetsToReconcile(now(), 10)) {
        await update(asset.assetId, {}, { $inc: { reconcileAttempts: 1 } });
        const result = await reconcile(asset);
        if (result.outcome !== "unknown") summary.reconciled += 1;
      }
      return summary;
    },
  };
};
