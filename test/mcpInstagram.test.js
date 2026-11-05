import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createInstagramTools,
  isTempPublicId,
  validateCaption,
} from "../src/services/mcp/instagramTools.js";
import {
  GraphError,
  createInstagramGraph,
} from "../src/services/mcp/instagramGraph.js";
import { cloudinaryUploader } from "../src/services/mcp/store.js";
import { MCP_SCOPES } from "../src/services/mcp/config.js";
import {
  GIF,
  PNG,
  createClock,
  createFakeGraph,
  createFakeUploader,
  createMemoryStore,
  ctxFor,
  runnerFor,
  testConfig,
} from "./support/mcpFakes.js";

const CTX = ctxFor([
  MCP_SCOPES.igRead,
  MCP_SCOPES.igUpload,
  MCP_SCOPES.igPublish,
  MCP_SCOPES.igCleanup,
]);
const MINUTE = 60000;

const setup = (overrides = {}) => {
  const clock = createClock();
  const store = createMemoryStore(clock);
  const uploader = createFakeUploader();
  const graph = createFakeGraph(clock);
  const config = testConfig(overrides);
  const tools = createInstagramTools({
    store,
    uploader,
    graph,
    runOperation: runnerFor(store, clock, 2 * MINUTE),
    config,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
  return { clock, store, uploader, graph, tools, config };
};

const creative = (seed = "a") =>
  Buffer.concat([PNG, Buffer.from(seed.repeat(16))]).toString("base64");
const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) =>
      error.code === code ||
      assert.fail(`expected ${code}, got ${error.code}: ${error.message}`),
  );

const uploadAndPublish = async (
  env,
  { seed = "a", key = "post-2026-11-06" } = {},
) => {
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: `${key}-up`, imageBase64: creative(seed) },
    CTX,
  );
  const published = await env.tools.publishInstagram(
    {
      idempotencyKey: `${key}-pub`,
      assetId: asset.assetId,
      caption: "Soft water, happy home. #Aquakart #WaterSoftener",
    },
    CTX,
  );
  return { asset, published };
};

test("valid upload goes to the temp namespace only; unsupported formats and bad ratios are refused", async () => {
  const env = setup();
  const { asset, deduplicated } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  assert.equal(deduplicated, false);
  assert.equal(asset.status, "UPLOADED");
  assert.match(
    asset.cloudinaryPublicId,
    /^aquakart\/instagram-temp\/ig_[a-f0-9]{32}$/,
  );
  assert.equal(asset.cleanupStatus, "none");
  assert.equal(asset.instagramMediaId, null);
  assert.match(asset.imageUrl, /\.jpg$/); // Meta receives JPEG

  const again = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0002", imageBase64: creative() },
    CTX,
  );
  assert.equal(again.deduplicated, true);
  assert.equal(again.asset.assetId, asset.assetId);

  await rejects(
    env.tools.uploadInstagramImage(
      { idempotencyKey: "ig-up-0003", imageBase64: GIF.toString("base64") },
      CTX,
    ),
    "UNSUPPORTED_IMAGE_TYPE",
  );
  env.uploader.dimensions = { width: 1080, height: 2400 };
  await rejects(
    env.tools.uploadInstagramImage(
      { idempotencyKey: "ig-up-0004", imageBase64: creative("b") },
      CTX,
    ),
    "INVALID_ASPECT_RATIO",
  );
  assert.ok(
    env.uploader.destroyed.some((id) =>
      id.startsWith("aquakart/instagram-temp/"),
    ),
  );
});

test("successful publication is verified and schedules cleanup 30 minutes later", async () => {
  const env = setup();
  const { published } = await uploadAndPublish(env);
  const { asset } = published;
  assert.equal(published.alreadyPublished, false);
  assert.equal(asset.status, "CLEANUP_PENDING");
  assert.match(asset.instagramMediaId, /^1801/);
  assert.match(asset.permalink, /^https:\/\/www\.instagram\.com\/p\//);
  assert.equal(asset.cleanupStatus, "pending");
  assert.equal(
    new Date(asset.cleanupAfter) - new Date(asset.verifiedAt),
    30 * MINUTE,
  );
  const record = env.store.assets[0];
  assert.deepEqual(
    record.history.map((entry) => entry.status),
    [
      "UPLOADED",
      "CONTAINER_CREATED",
      "READY",
      "PUBLISHING",
      "PUBLISHED_VERIFIED",
      "CLEANUP_PENDING",
    ],
  );
  assert.equal(env.graph.calls.publishContainer, 1);
  assert.equal(env.uploader.destroyed.length, 0, "not deleted at publish time");
});

test("duplicate publish requests never post twice", async () => {
  const env = setup();
  const { asset } = await uploadAndPublish(env);
  const replay = await env.tools.publishInstagram(
    {
      idempotencyKey: "post-2026-11-06-pub",
      assetId: asset.assetId,
      caption: "Soft water, happy home. #Aquakart #WaterSoftener",
    },
    CTX,
  );
  assert.equal(replay.replayed, true);
  const second = await env.tools.publishInstagram(
    {
      idempotencyKey: "another-key-123",
      assetId: asset.assetId,
      caption: "Different caption",
    },
    CTX,
  );
  assert.equal(second.alreadyPublished, true);
  assert.equal(env.graph.calls.publishContainer, 1);
  // The same image can't come back as a new post after cleanup either.
  env.clock.advance(31 * MINUTE);
  await env.tools.runMaintenancePass();
  await rejects(
    env.tools.uploadInstagramImage(
      { idempotencyKey: "ig-reupload", imageBase64: creative() },
      CTX,
    ),
    "ALREADY_POSTED",
  );
});

test("failed container processing keeps the asset for retry", async () => {
  const env = setup();
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  env.graph.containerStates.push("ERROR");
  await rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: asset.assetId,
        caption: "Hello",
      },
      CTX,
    ),
    "CONTAINER_FAILED",
  );
  const record = env.store.assets[0];
  assert.equal(record.status, "FAILED");
  assert.equal(record.cleanupStatus, "none");
  assert.equal(env.uploader.destroyed.length, 0);
  assert.equal(env.graph.calls.publishContainer, 0);
  // Retry with the same key creates a fresh container and succeeds.
  const retried = await env.tools.publishInstagram(
    { idempotencyKey: "ig-pub-0001", assetId: asset.assetId, caption: "Hello" },
    CTX,
  );
  assert.equal(retried.asset.status, "CLEANUP_PENDING");
  assert.equal(env.graph.calls.createContainer, 2);
});

test("slow container processing returns a retryable status without publishing", async () => {
  const env = setup({ INSTAGRAM_CONTAINER_POLL_ATTEMPTS: "3" });
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  env.graph.containerStates.push("IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS");
  await assert.rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: asset.assetId,
        caption: "Hello",
      },
      CTX,
    ),
    (error) =>
      error.code === "CONTAINER_PROCESSING" && error.retryable === true,
  );
  assert.equal(env.store.assets[0].status, "PROCESSING");
  const done = await env.tools.publishInstagram(
    { idempotencyKey: "ig-pub-0001", assetId: asset.assetId, caption: "Hello" },
    CTX,
  );
  assert.equal(done.asset.status, "CLEANUP_PENDING");
  assert.equal(
    env.graph.calls.createContainer,
    1,
    "the same container is reused",
  );
});

test("a Meta timeout before publishing is retryable and creates no post", async () => {
  const env = setup();
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  env.graph.failCreate = new GraphError(
    "META_TIMEOUT",
    "Meta did not answer in time",
    { transient: true },
  );
  await assert.rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: asset.assetId,
        caption: "Hello",
      },
      CTX,
    ),
    (error) => error.code === "META_TIMEOUT" && error.retryable === true,
  );
  assert.equal(env.store.assets[0].status, "UPLOADED");
  env.graph.failCreate = null;
  const done = await env.tools.publishInstagram(
    { idempotencyKey: "ig-pub-0001", assetId: asset.assetId, caption: "Hello" },
    CTX,
  );
  assert.equal(done.asset.status, "CLEANUP_PENDING");
});

test("a lost media_publish response is reconciled instead of re-posted", async () => {
  const env = setup();
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  env.graph.failPublish = "timeout-after-publish"; // Meta posted it, but we never heard back
  const result = await env.tools.publishInstagram(
    {
      idempotencyKey: "ig-pub-0001",
      assetId: asset.assetId,
      caption: "Hello there",
    },
    CTX,
  );
  assert.equal(result.asset.status, "CLEANUP_PENDING");
  assert.match(result.asset.instagramMediaId, /^1801/);
  assert.equal(env.graph.calls.publishContainer, 1);
  assert.equal(env.graph.media.size, 1);
});

test("an unknown publish outcome is never retried blindly or cleaned up", async () => {
  const env = setup();
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  env.graph.failPublish = "timeout-after-publish";
  env.graph.failGetContainer = true; // can't reconcile right now either
  let failedAtPublish = false;
  const original = env.graph.getContainer;
  env.graph.getContainer = async (id) => {
    if (failedAtPublish) return original(id);
    if (env.graph.calls.publishContainer > 0) failedAtPublish = true;
    if (failedAtPublish)
      throw new GraphError("META_TIMEOUT", "timeout", { transient: true });
    env.graph.failGetContainer = false;
    return original(id);
  };
  await rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: asset.assetId,
        caption: "Hello there",
      },
      CTX,
    ),
    "PUBLISH_UNCERTAIN",
  );
  assert.equal(env.store.assets[0].status, "PUBLISH_UNCERTAIN");
  // Cleanup is refused while the outcome is uncertain.
  await rejects(
    env.tools.cleanupInstagramAsset(
      { idempotencyKey: "ig-clean-0001", assetId: asset.assetId },
      CTX,
    ),
    "CLEANUP_NOT_ALLOWED",
  );
  // Meta still unreachable: a retry must not call media_publish again.
  env.graph.getContainer = async () => {
    throw new GraphError("META_TIMEOUT", "timeout", { transient: true });
  };
  await rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0002",
        assetId: asset.assetId,
        caption: "Hello there",
      },
      CTX,
    ),
    "PUBLISH_UNCERTAIN",
  );
  assert.equal(env.graph.calls.publishContainer, 1);
  // Once Meta answers, the background pass reconciles it to verified.
  env.graph.getContainer = original;
  const summary = await env.tools.runMaintenancePass();
  assert.equal(summary.reconciled, 1);
  assert.equal(env.store.assets[0].status, "CLEANUP_PENDING");
  assert.equal(env.graph.calls.publishContainer, 1);
});

test("partial MongoDB failure after posting is recovered without a duplicate post", async () => {
  const env = setup();
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  env.store.calls.failNextAssetUpdate = (change) =>
    change.$set?.status === "CLEANUP_PENDING";
  await rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: asset.assetId,
        caption: "Hello",
      },
      CTX,
    ),
    "STORAGE_UNAVAILABLE",
  );
  assert.equal(env.store.assets[0].status, "PUBLISHING");
  assert.ok(env.store.assets[0].instagramMediaId);
  // While the publish lease is live, retries wait instead of re-posting.
  await rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: asset.assetId,
        caption: "Hello",
      },
      CTX,
    ),
    "PUBLISH_IN_PROGRESS",
  );
  env.clock.advance(3 * MINUTE);
  const recovered = await env.tools.publishInstagram(
    { idempotencyKey: "ig-pub-0001", assetId: asset.assetId, caption: "Hello" },
    CTX,
  );
  assert.equal(recovered.alreadyPublished, true);
  assert.equal(recovered.asset.status, "CLEANUP_PENDING");
  assert.equal(env.graph.calls.publishContainer, 1);
});

test("cleanup runs only after the delay, deletes the exact temp id, and is confirmed by status", async () => {
  const env = setup({ INSTAGRAM_CLEANUP_DELAY_MINUTES: "45" });
  const { asset } = await uploadAndPublish(env);
  env.clock.advance(44 * MINUTE);
  assert.deepEqual(await env.tools.runMaintenancePass(), {
    cleaned: 0,
    retried: 0,
    blocked: 0,
    reconciled: 0,
  });
  assert.equal(env.uploader.destroyed.length, 0);
  env.clock.advance(2 * MINUTE);
  const summary = await env.tools.runMaintenancePass();
  assert.equal(summary.cleaned, 1);
  assert.deepEqual(env.uploader.destroyed, [asset.cloudinaryPublicId]);
  const status = await env.tools.getInstagramStatus({ assetId: asset.assetId });
  assert.equal(status.asset.status, "CLEANED");
  assert.equal(status.asset.cleanupStatus, "done");
  assert.equal(status.asset.imageUrl, null);
  assert.ok(status.asset.cleanedAt);
});

test("cleanup resumes after a crash and treats an already-deleted image as cleaned", async () => {
  const env = setup();
  const { asset } = await uploadAndPublish(env);
  env.clock.advance(31 * MINUTE);
  // Process A deletes from Cloudinary, then crashes before updating MongoDB.
  const leased = await env.store.claimDueCleanup(
    env.clock.now(),
    new Date(env.clock.now().getTime() + 5 * MINUTE),
  );
  await env.uploader.destroyTemp(leased.cloudinaryPublicId);
  assert.equal(env.store.assets[0].cleanupStatus, "in_progress");
  // Before the lease expires nobody else takes it...
  assert.equal((await env.tools.runMaintenancePass()).cleaned, 0);
  // ...after it expires (e.g. after restart) the next pass finishes the job.
  env.clock.advance(6 * MINUTE);
  const summary = await env.tools.runMaintenancePass();
  assert.equal(summary.cleaned, 1);
  assert.equal(env.store.assets[0].status, "CLEANED");
  assert.equal(env.store.assets[0].history.at(-1).note, "already absent");
  assert.equal(asset.cloudinaryPublicId, leased.cloudinaryPublicId);
});

test("Cloudinary deletion failures retry with exponential backoff", async () => {
  const env = setup();
  await uploadAndPublish(env);
  env.clock.advance(31 * MINUTE);
  env.uploader.failDestroy = 2;
  assert.equal((await env.tools.runMaintenancePass()).retried, 1);
  const first = env.store.assets[0];
  assert.equal(first.cleanupAttempts, 1);
  assert.equal(first.cleanupStatus, "pending");
  assert.equal(
    new Date(first.cleanupNextAttemptAt) - env.clock.now(),
    1 * MINUTE,
  );
  assert.equal(
    (await env.tools.runMaintenancePass()).retried,
    0,
    "not before the backoff",
  );
  env.clock.advance(1 * MINUTE);
  assert.equal((await env.tools.runMaintenancePass()).retried, 1);
  assert.equal(
    new Date(env.store.assets[0].cleanupNextAttemptAt) - env.clock.now(),
    2 * MINUTE,
  );
  env.clock.advance(2 * MINUTE);
  assert.equal((await env.tools.runMaintenancePass()).cleaned, 1);
  assert.equal(env.store.assets[0].status, "CLEANED");
});

test("cleanup never targets assets outside aquakart/instagram-temp/", async () => {
  const env = setup();
  await uploadAndPublish(env);
  env.store.assets[0].cloudinaryPublicId = "Blogs/staff-hero-image";
  env.clock.advance(31 * MINUTE);
  assert.equal((await env.tools.runMaintenancePass()).blocked, 1);
  assert.equal(env.uploader.destroyed.length, 0);
  assert.equal(env.store.assets[0].cleanupStatus, "blocked");
  assert.equal(
    isTempPublicId("aquakart/instagram-temp/ig_" + "a".repeat(32)),
    true,
  );
  assert.equal(isTempPublicId("aquakart/instagram-temp/../Blogs/x"), false);
  assert.equal(isTempPublicId("Products/abc"), false);
  // The real Cloudinary adapter refuses before any network call.
  assert.throws(
    () => cloudinaryUploader.destroyTemp("Products/water-softener"),
    /outside the Instagram temp folder/,
  );
  assert.throws(
    () => cloudinaryUploader.destroy("Blogs/staff-upload"),
    /non-MCP image/,
  );
});

test("manual cleanup is limited to verified or never-sent assets", async () => {
  const env = setup();
  const { asset } = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0001", imageBase64: creative() },
    CTX,
  );
  const cleaned = await env.tools.cleanupInstagramAsset(
    { idempotencyKey: "ig-clean-0001", assetId: asset.assetId },
    CTX,
  );
  assert.equal(cleaned.cleaned, true);
  assert.equal(cleaned.asset.status, "CLEANED");
  const other = await env.tools.uploadInstagramImage(
    { idempotencyKey: "ig-up-0002", imageBase64: creative("z") },
    CTX,
  );
  env.store.assets[1].status = "PUBLISHING";
  env.store.assets[1].containerId = "17891";
  await rejects(
    env.tools.cleanupInstagramAsset(
      { idempotencyKey: "ig-clean-0002", assetId: other.asset.assetId },
      CTX,
    ),
    "CLEANUP_NOT_ALLOWED",
  );
});

test("history lists recorded posts", async () => {
  const env = setup();
  await uploadAndPublish(env, { seed: "a", key: "post-one" });
  await uploadAndPublish(env, { seed: "b", key: "post-two" });
  const list = await env.tools.listInstagramPosts({ page: 1, limit: 10 });
  assert.equal(list.total, 2);
  assert.ok(
    list.assets.every(
      (asset) => asset.status === "CLEANUP_PENDING" && asset.permalink,
    ),
  );
});

test("caption validation follows Instagram limits", () => {
  assert.equal(validateCaption("  Hello\r\nworld  "), "Hello\nworld");
  assert.throws(
    () => validateCaption("x".repeat(2201)),
    (error) => error.code === "INVALID_CAPTION",
  );
  assert.throws(
    () =>
      validateCaption(
        Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" "),
      ),
    (error) => error.code === "INVALID_CAPTION",
  );
  assert.throws(
    () => validateCaption("<b>bold</b>"),
    (error) => error.code === "INVALID_CAPTION",
  );
});

test("publishing reports INSTAGRAM_NOT_CONFIGURED without credentials", async () => {
  const env = setup({ INSTAGRAM_ACCESS_TOKEN: "" });
  await rejects(
    env.tools.publishInstagram(
      {
        idempotencyKey: "ig-pub-0001",
        assetId: `iga_${"0".repeat(8)}-0000-0000-0000-000000000000`,
        caption: "x",
      },
      CTX,
    ),
    "INSTAGRAM_NOT_CONFIGURED",
  );
});

test("Graph client sends the token only in the header and maps Meta errors", async () => {
  const token = `EAAG${randomBytes(16).toString("hex")}`;
  const seen = [];
  const respond = (status, body) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  const answers = [
    respond(200, { id: "17890001" }),
    respond(400, {
      error: { code: 190, message: "Error validating access token" },
    }),
    respond(400, {
      error: { code: 4, message: "Application request limit reached" },
    }),
    respond(503, {
      error: {
        code: 2,
        message: "Service temporarily unavailable",
        is_transient: true,
      },
    }),
  ];
  const graph = createInstagramGraph(
    {
      configured: true,
      userId: "17841400000000000",
      accessToken: token,
      graphBaseUrl: "https://graph.facebook.com",
      apiVersion: "v26.0",
      requestTimeoutMs: 1000,
    },
    {
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return answers.shift();
      },
    },
  );
  assert.equal(
    await graph.createContainer({
      imageUrl: "https://res.cloudinary.com/x.jpg",
      caption: "hi",
    }),
    "17890001",
  );
  assert.equal(seen[0].init.headers.authorization, `Bearer ${token}`);
  assert.ok(!seen[0].url.includes(token));
  assert.ok(!String(seen[0].init.body).includes(token));
  await assert.rejects(
    graph.getContainer("1"),
    (error) =>
      error.code === "INSTAGRAM_TOKEN_INVALID" &&
      !error.message.includes(token),
  );
  await assert.rejects(
    graph.publishContainer("1"),
    (error) => error.code === "META_RATE_LIMITED" && error.retryable === true,
  );
  await assert.rejects(
    graph.getMedia("1"),
    (error) => error.code === "META_UNAVAILABLE" && error.retryable === true,
  );

  const slow = createInstagramGraph(
    {
      configured: true,
      userId: "1",
      accessToken: token,
      graphBaseUrl: "https://graph.facebook.com",
      apiVersion: "v26.0",
      requestTimeoutMs: 1000,
    },
    {
      fetchImpl: async () => {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      },
    },
  );
  await assert.rejects(
    slow.getMedia("1"),
    (error) => error.code === "META_TIMEOUT" && error.retryable === true,
  );
});
