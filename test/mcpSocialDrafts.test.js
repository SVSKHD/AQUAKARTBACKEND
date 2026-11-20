import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBlogTools } from "../src/services/mcp/blogTools.js";
import { createInstagramTools } from "../src/services/mcp/instagramTools.js";
import { createSocialTools } from "../src/services/mcp/socialTools.js";
import { createAquakartMcpServer } from "../src/services/mcp/server.js";
import { GraphError } from "../src/services/mcp/instagramGraph.js";
import { MCP_SCOPES, SCOPE_PERMISSIONS } from "../src/services/mcp/config.js";
import { createSocialPostController } from "../src/controllers/crm/socialPosts.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import {
  createClock,
  createFakeGraph,
  createFakeUploader,
  createMemoryStore,
  ctxFor,
  runnerFor,
  testConfig,
} from "./support/mcpFakes.js";
import {
  DRIVE_ENV,
  OTHER_FOLDER,
  FOLDER,
  createFakeDrive,
  pngOf,
} from "./support/driveFakes.js";

// Social post drafts: MCP create/update/get/list, CRM review and the
// publish hand-off to the real Instagram tools (fake Meta + Cloudinary).

const SOCIAL = ctxFor([
  MCP_SCOPES.socialRead,
  MCP_SCOPES.socialWrite,
  MCP_SCOPES.upload,
]);
const REVIEWER = ctxFor([], {
  clientId: "crm",
  adminUserId: "64b0000000000000000000aa",
});
const CAPTION =
  "White spots on taps and tiles? That's hard water. Ask us about softeners. #HardWater #Aquakart";

const setup = (envOverrides = {}) => {
  const clock = createClock();
  const store = createMemoryStore(clock);
  const uploader = createFakeUploader();
  const graph = createFakeGraph(clock);
  const drive = createFakeDrive();
  const config = testConfig({ ...DRIVE_ENV, ...envOverrides });
  const runOperation = runnerFor(store, clock);
  const audits = [];
  const logs = [];
  const audit = async (entry) => audits.push(entry);
  const log = { log: (line) => logs.push(line), error: () => {} };
  const blogTools = createBlogTools({
    store,
    uploader,
    drive,
    runOperation,
    config,
    now: clock.now,
    audit,
    log,
  });
  const instagramTools = createInstagramTools({
    store,
    uploader,
    graph,
    runOperation,
    config,
    now: clock.now,
    sleep: async () => {},
    audit,
  });
  const posterBytes = new Map();
  const social = createSocialTools({
    store,
    blogTools,
    instagramTools,
    drive,
    runOperation,
    config,
    now: clock.now,
    audit,
    log,
    fetchMediaBytes: async (media) =>
      posterBytes.get(media.publicId) || pngOf(1080, 1350, media.sha256),
  });
  // A stored poster (what aquakart_create_image_upload leaves behind).
  const seedMedia = async ({ width = 1080, height = 1350 } = {}) => {
    const sha = createHash("sha256").update(randomBytes(16)).digest("hex");
    return store.createMedia({
      sha256: sha,
      publicId: `Blogs/mcp_${sha.slice(0, 32)}`,
      secureUrl: `https://res.cloudinary.com/demo/image/upload/Blogs/mcp_${sha.slice(0, 32)}.png`,
      format: "png",
      bytes: 1234,
      width,
      height,
      source: "upload-url",
      status: "active",
    });
  };
  return {
    clock,
    store,
    uploader,
    graph,
    drive,
    config,
    social,
    blogTools,
    audits,
    logs,
    seedMedia,
  };
};

const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) =>
      error.code === code ||
      assert.fail(`expected ${code}, got ${error.code}: ${error.message}`),
  );

const draftArgs = (mediaId, overrides = {}) => ({
  mediaId,
  platforms: ["instagram", "facebook"],
  title: "White spots on taps and tiles?",
  caption: CAPTION,
  altText: "Bathroom tap with white limescale spots",
  ...overrides,
});

const approve = (social, post, note = "Looks good") =>
  social.reviewSocialPost(
    { postId: post.postId, decision: "approved", note },
    REVIEWER,
  );

test("Claude Code: uploaded poster + caption becomes an unpublished draft that reads back verified", async () => {
  const { social, seedMedia, audits, store, graph } = setup();
  const media = await seedMedia();
  const created = await social.createSocialDraft(
    draftArgs(String(media._id), { idempotencyKey: "social-2026-11-20-01" }),
    SOCIAL,
  );
  assert.equal(created.alreadyExists, false);
  assert.equal(created.replayed, false);
  const { post } = created;
  assert.equal(post.status, "draft");
  assert.deepEqual(post.platforms, ["instagram", "facebook"]);
  assert.equal(post.image.mediaId, String(media._id));
  assert.equal(post.image.imageUrl, media.secureUrl);
  assert.equal(post.caption, CAPTION);
  assert.equal(post.checks.readyForReview, true);
  assert.deepEqual(
    post.checks.warnings.map((w) => w.check),
    ["facebook"],
  );
  assert.equal(post.review, null);
  assert.equal(post.publishing.instagram, null);

  const { post: readBack } = await social.getSocialDraft({
    postId: post.postId,
  });
  assert.equal(readBack.revision, post.revision);
  assert.equal(readBack.status, "draft");
  assert.equal(store.socialPosts.length, 1);
  assert.equal(graph.calls.createContainer, 0, "nothing sent to Meta");
  assert.ok(audits.some((a) => a.action === "mcp.social.create"));

  const listed = await social.listSocialDrafts({ status: "draft" });
  assert.equal(listed.total, 1);
  assert.equal(listed.posts[0].postId, post.postId);
});

test("8:30 automation: a draft is built from the Drive image, caption file and metadata JSON", async () => {
  const { social, drive, store } = setup();
  drive.add("posterFile000001", pngOf(1080, 1350));
  drive.addText("captionFile00001", `﻿${CAPTION}\n`);
  drive.addText(
    "metadataFile0001",
    JSON.stringify({
      title: "Hard water spots (from metadata)",
      platforms: ["instagram"],
      altText: "Limescale on a tap",
      scheduledFor: "2026-11-21T12:30:00+05:30",
    }),
    { mimeType: "application/json", name: "metadata.json" },
  );
  const source = {
    type: "google_drive",
    folderId: FOLDER,
    imageFileId: "posterFile000001",
    captionFileId: "captionFile00001",
    metadataFileId: "metadataFile0001",
  };
  const { post } = await social.createSocialDraft(
    { source, title: "Explicit title wins" },
    SOCIAL,
  );
  assert.equal(post.title, "Explicit title wins");
  assert.deepEqual(post.platforms, ["instagram"]);
  assert.equal(post.caption, CAPTION, "BOM and trailing newline removed");
  assert.equal(post.altText, "Limescale on a tap");
  assert.equal(post.scheduledFor, "2026-11-21T07:00:00.000Z");
  assert.deepEqual(post.source, {
    type: "google_drive",
    folderId: FOLDER,
    imageFileId: "posterFile000001",
    captionFileId: "captionFile00001",
    metadataFileId: "metadataFile0001",
  });
  assert.equal(store.media.length, 1);
  assert.equal(store.media[0].source, "google-drive");
  assert.equal(store.media[0].sourceRef.fileId, "posterFile000001");
  assert.equal(post.status, "draft");

  // Running the import again (same files) changes nothing.
  const again = await social.createSocialDraft(
    { source, title: "Explicit title wins" },
    SOCIAL,
  );
  assert.equal(again.replayed, true);
  assert.equal(store.socialPosts.length, 1);
});

test("a Google Doc caption is exported as text", async () => {
  const { social, drive } = setup();
  drive.add("posterFile000002", pngOf(1080, 1080));
  drive.addText("captionGoogleDoc1", CAPTION, {
    mimeType: "application/vnd.google-apps.document",
    md5Checksum: undefined,
    version: "17",
  });
  const { post } = await social.createSocialDraft(
    {
      title: "Square poster",
      source: {
        type: "google_drive",
        imageFileId: "posterFile000002",
        captionFileId: "captionGoogleDoc1",
      },
    },
    SOCIAL,
  );
  assert.equal(post.caption, CAPTION);
  assert.equal(drive.calls.export, 1);
});

test("Drive sources are checked: folder, folderId, file types and metadata", async () => {
  const { social, drive } = setup();
  drive.add("posterElsewhere1", pngOf(1080, 1350), { parents: [OTHER_FOLDER] });
  drive.add("posterOk00000001", pngOf(1080, 1350));
  drive.add("captionPdf000001", Buffer.from("%PDF"), {
    mimeType: "application/pdf",
  });
  drive.addText("metadataBroken01", "{ not json", {
    mimeType: "application/json",
  });
  const base = (source, extra = {}) =>
    social.createSocialDraft(
      {
        title: "Checks",
        caption: CAPTION,
        source: { type: "google_drive", ...source },
        ...extra,
      },
      SOCIAL,
    );
  await rejects(
    base({ imageFileId: "posterElsewhere1" }),
    "DRIVE_FOLDER_NOT_ALLOWED",
  );
  await rejects(
    base({ imageFileId: "posterOk00000001", folderId: OTHER_FOLDER }),
    "DRIVE_FOLDER_MISMATCH",
  );
  await rejects(
    base({
      imageFileId: "posterOk00000001",
      captionFileId: "captionPdf000001",
    }),
    "UNSUPPORTED_SOURCE_FILE",
  );
  await rejects(
    base({
      imageFileId: "posterOk00000001",
      metadataFileId: "metadataBroken01",
    }),
    "INVALID_METADATA",
  );
  await rejects(
    base({ imageFileId: "doesNotExist0001" }),
    "DRIVE_FILE_NOT_FOUND",
  );
  const off = setup({ GOOGLE_DRIVE_BANNER_FOLDER_IDS: "" });
  await rejects(
    off.social.createSocialDraft(
      {
        title: "Checks",
        caption: CAPTION,
        source: { type: "google_drive", imageFileId: "posterOk00000001" },
      },
      SOCIAL,
    ),
    "DRIVE_NOT_CONFIGURED",
  );
});

test("drafts are validated: caption rules, poster shape, required fields and one image input", async () => {
  const { social, seedMedia, store } = setup();
  const portrait = await seedMedia();
  const banner = await seedMedia({ width: 1500, height: 500 }); // 3:1
  const tooManyTags = `${"#tag ".repeat(31)}`.trim();
  await rejects(
    social.createSocialDraft(
      draftArgs(String(portrait._id), { caption: tooManyTags }),
      SOCIAL,
    ),
    "INVALID_CAPTION",
  );
  await rejects(
    social.createSocialDraft(
      draftArgs(String(portrait._id), { caption: "<b>Sale</b> today" }),
      SOCIAL,
    ),
    "INVALID_CAPTION",
  );
  await rejects(
    social.createSocialDraft(draftArgs(String(banner._id)), SOCIAL),
    "INVALID_ASPECT_RATIO",
  );
  // Facebook-only: no Instagram ratio or hashtag limits.
  const fb = await social.createSocialDraft(
    draftArgs(String(banner._id), {
      platforms: ["facebook"],
      caption: tooManyTags,
    }),
    SOCIAL,
  );
  assert.equal(fb.post.status, "draft");
  await rejects(
    social.createSocialDraft(
      draftArgs(String(portrait._id), { title: undefined }),
      SOCIAL,
    ),
    "VALIDATION_FAILED",
  );
  await rejects(
    social.createSocialDraft(
      {
        ...draftArgs(String(portrait._id)),
        source: { type: "google_drive", imageFileId: "posterOk00000001" },
      },
      SOCIAL,
    ),
    "VALIDATION_FAILED",
  );
  await rejects(
    social.createSocialDraft(draftArgs("64b00000000000000000ffff"), SOCIAL),
    "MEDIA_NOT_FOUND",
  );
  assert.equal(store.socialPosts.length, 1);
});

test("the same poster, caption and platforms are drafted once", async () => {
  const { social, seedMedia, store } = setup();
  const media = await seedMedia();
  const first = await social.createSocialDraft(
    draftArgs(String(media._id), { idempotencyKey: "social-dup-key-1" }),
    SOCIAL,
  );
  const replay = await social.createSocialDraft(
    draftArgs(String(media._id), { idempotencyKey: "social-dup-key-1" }),
    SOCIAL,
  );
  assert.equal(replay.replayed, true);
  const other = await social.createSocialDraft(
    draftArgs(String(media._id), { idempotencyKey: "social-dup-key-2" }),
    SOCIAL,
  );
  assert.equal(other.alreadyExists, true);
  assert.equal(other.post.postId, first.post.postId);
  const concurrent = await Promise.all(
    ["social-race-a1", "social-race-b2"].map((idempotencyKey) =>
      social.createSocialDraft(
        draftArgs(String(media._id), {
          idempotencyKey,
          caption: `${CAPTION} #Race`,
        }),
        SOCIAL,
      ),
    ),
  );
  assert.equal(concurrent[0].post.postId, concurrent[1].post.postId);
  assert.equal(store.socialPosts.length, 2);
});

test("MCP edits drafts and rejected posts only; edits need a fresh revision", async () => {
  const { social, seedMedia } = setup();
  const media = await seedMedia();
  const { post } = await social.createSocialDraft(
    draftArgs(String(media._id)),
    SOCIAL,
  );
  const edited = await social.updateSocialDraft(
    {
      idempotencyKey: "social-edit-0001",
      postId: post.postId,
      expectedRevision: post.revision,
      caption: `${CAPTION} Call 1800-000-000.`,
      notes: "Uses the November offer",
    },
    SOCIAL,
  );
  assert.notEqual(edited.post.revision, post.revision);
  assert.match(edited.post.caption, /1800-000-000/);
  await rejects(
    social.updateSocialDraft(
      {
        idempotencyKey: "social-edit-0002",
        postId: post.postId,
        expectedRevision: post.revision,
        title: "Stale edit",
      },
      SOCIAL,
    ),
    "REVISION_CONFLICT",
  );

  // Rejected -> edited -> back to draft for another review.
  await social.reviewSocialPost(
    { postId: post.postId, decision: "rejected", note: "Wrong phone number" },
    REVIEWER,
  );
  const fixed = await social.updateSocialDraft(
    {
      idempotencyKey: "social-edit-0003",
      postId: post.postId,
      caption: CAPTION,
    },
    SOCIAL,
  );
  assert.equal(fixed.post.status, "draft");
  assert.equal(fixed.post.review.decision, "rejected", "reason kept");

  // Approved posts are edited only in the CRM, which sends them back to draft.
  await approve(social, fixed.post);
  await rejects(
    social.updateSocialDraft(
      {
        idempotencyKey: "social-edit-0004",
        postId: post.postId,
        title: "Too late",
      },
      SOCIAL,
    ),
    "SOCIAL_POST_NOT_EDITABLE",
  );
  const crmEdit = await social.editSocialPost(
    { postId: post.postId, title: "Reviewer tweak" },
    REVIEWER,
  );
  assert.equal(crmEdit.post.status, "draft");
});

test("only staff approve or reject, with readiness checks and a reason for rejection", async () => {
  const { social, seedMedia, audits } = setup();
  const media = await seedMedia();
  const { post } = await social.createSocialDraft(
    draftArgs(String(media._id)),
    SOCIAL,
  );
  await rejects(
    social.reviewSocialPost(
      { postId: post.postId, decision: "rejected" },
      REVIEWER,
    ),
    "VALIDATION_FAILED",
  );
  await rejects(
    social.reviewSocialPost(
      {
        postId: post.postId,
        decision: "approved",
        expectedRevision: "2020-01-01T00:00:00.000Z",
      },
      REVIEWER,
    ),
    "REVISION_CONFLICT",
  );
  const { post: approved } = await approve(social, post);
  assert.equal(approved.status, "approved");
  assert.equal(approved.review.decision, "approved");
  assert.equal(approved.review.by, REVIEWER.auth.adminUserId);
  await rejects(approve(social, approved), "INVALID_STATUS");
  assert.ok(audits.some((a) => a.action === "crm.social.approve"));
});

test("publishing needs approval, posts once through the Instagram pipeline and keeps the Cloudinary poster", async () => {
  const { social, seedMedia, graph, store, uploader } = setup();
  const media = await seedMedia();
  const { post } = await social.createSocialDraft(
    draftArgs(String(media._id)),
    SOCIAL,
  );
  await rejects(
    social.publishSocialPost({ postId: post.postId }, REVIEWER),
    "SOCIAL_POST_NOT_APPROVED",
  );
  assert.equal(graph.calls.createContainer, 0);

  await approve(social, post);
  const result = await social.publishSocialPost(
    { postId: post.postId },
    REVIEWER,
  );
  assert.equal(result.alreadyPublished, false);
  assert.equal(result.post.status, "published");
  const ig = result.post.publishing.instagram;
  assert.equal(ig.status, "published");
  assert.match(ig.externalId, /^1801/);
  assert.match(ig.permalink, /^https:\/\/www\.instagram\.com\/p\//);
  assert.equal(result.post.publishing.facebook.status, "unsupported");
  assert.equal(graph.calls.publishContainer, 1);
  assert.equal(
    [...graph.containers.values()][0].caption,
    CAPTION,
    "caption from the draft",
  );
  assert.equal(store.media[0].status, "active", "permanent poster untouched");
  assert.ok(
    [...uploader.uploaded.keys()].some((id) =>
      id.startsWith("aquakart/instagram-temp/"),
    ),
    "Instagram got its own temporary copy",
  );

  const again = await social.publishSocialPost(
    { postId: post.postId },
    REVIEWER,
  );
  assert.equal(again.alreadyPublished, true);
  assert.equal(graph.calls.publishContainer, 1);
});

test("a failed publish returns the post to approved and a retry posts exactly once", async () => {
  const { social, seedMedia, graph } = setup();
  const media = await seedMedia();
  const { post } = await social.createSocialDraft(
    draftArgs(String(media._id)),
    SOCIAL,
  );
  await approve(social, post);
  graph.failCreate = new GraphError("META_RATE_LIMITED", "Too many calls", {
    transient: true,
  });
  await assert.rejects(
    social.publishSocialPost({ postId: post.postId }, REVIEWER),
  );
  const { post: failed } = await social.getSocialDraft({ postId: post.postId });
  assert.equal(failed.status, "approved");
  assert.equal(failed.publishing.instagram.status, "failed");
  assert.ok(failed.publishing.instagram.lastError.code);

  graph.failCreate = null;
  const retried = await social.publishSocialPost(
    { postId: post.postId },
    REVIEWER,
  );
  assert.equal(retried.post.status, "published");
  assert.equal(graph.calls.publishContainer, 1);
});

test("concurrent publish requests post once; Facebook-only posts are refused", async () => {
  const { social, seedMedia, graph } = setup();
  const media = await seedMedia();
  const { post } = await social.createSocialDraft(
    draftArgs(String(media._id)),
    SOCIAL,
  );
  await approve(social, post);
  const results = await Promise.allSettled([
    social.publishSocialPost({ postId: post.postId }, REVIEWER),
    social.publishSocialPost({ postId: post.postId }, REVIEWER),
  ]);
  for (const r of results)
    if (r.status === "rejected")
      assert.equal(r.reason.code, "PUBLISH_IN_PROGRESS");
  assert.ok(results.some((r) => r.status === "fulfilled"));
  assert.equal(graph.calls.publishContainer, 1);

  const fbMedia = await seedMedia({ width: 1500, height: 500 });
  const { post: fb } = await social.createSocialDraft(
    draftArgs(String(fbMedia._id), { platforms: ["facebook"] }),
    SOCIAL,
  );
  await approve(social, fb);
  await rejects(
    social.publishSocialPost({ postId: fb.postId }, REVIEWER),
    "PLATFORM_NOT_SUPPORTED",
  );
});

test("replacing a blog banner never deletes a poster a social draft still uses", async () => {
  const { social, blogTools, uploader, store } = setup();
  const write = ctxFor([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.upload]);
  const upload = async (seed) =>
    (
      await blogTools.uploadImage(
        {
          idempotencyKey: `upload-${seed}`,
          imageBase64: pngOf(1080, 1350, Buffer.from(seed)).toString("base64"),
        },
        write,
      )
    ).media;
  const shared = await upload("shared-poster");
  const other = await upload("other-banner");
  const { blog } = await blogTools.createBlog(
    {
      idempotencyKey: "blog-shared-image",
      title: "A blog that shares its banner",
      description: "<p>Short article about hard water and taps.</p>",
    },
    write,
  );
  await social.createSocialDraft(
    draftArgs(shared.mediaId, { platforms: ["facebook"] }),
    SOCIAL,
  );
  await blogTools.attachImage(
    {
      idempotencyKey: "attach-shared-1",
      blogId: blog.blogId,
      mediaId: shared.mediaId,
    },
    write,
  );
  await blogTools.attachImage(
    {
      idempotencyKey: "attach-other-01",
      blogId: blog.blogId,
      mediaId: other.mediaId,
    },
    write,
  );
  assert.deepEqual(uploader.destroyed, []);
  assert.equal(
    store.media.find((m) => m._id === shared.mediaId).status,
    "active",
  );
});

test("MCP tools: scopes enforced, no approve tool, schema-valid results", async () => {
  const { social, seedMedia } = setup();
  const media = await seedMedia();
  const connect = async (scopes) => {
    const server = createAquakartMcpServer({
      blogTools: {},
      instagramTools: {},
      socialTools: social,
      auth: {
        clientId: "mcp_test-client",
        adminUserId: "64b000000000000000000001",
        scopes,
      },
      correlationId: "corr-social-test",
      resourceMetadataUrl: "http://localhost/.well-known/x",
      log: { log: () => {}, error: () => {} },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  };

  const readOnly = await connect([MCP_SCOPES.socialRead]);
  const denied = await readOnly.callTool({
    name: "aquakart_create_social_draft",
    arguments: draftArgs(String(media._id)),
  });
  assert.equal(denied.isError, true);
  assert.equal(
    JSON.parse(denied.content[0].text).error.code,
    "INSUFFICIENT_SCOPE",
  );

  const client = await connect([
    MCP_SCOPES.socialRead,
    MCP_SCOPES.socialWrite,
    MCP_SCOPES.upload,
  ]);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).filter((n) => n.includes("social"));
  assert.deepEqual(names.sort(), [
    "aquakart_create_social_draft",
    "aquakart_get_social_draft",
    "aquakart_list_social_drafts",
    "aquakart_publish_social_post",
    "aquakart_update_social_draft",
  ]);
  assert.ok(!tools.some((t) => /approve|review/.test(t.name)));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(
    byName.aquakart_publish_social_post._meta.securitySchemes[0].scopes,
    ["instagram:publish"],
  );

  const created = await client.callTool({
    name: "aquakart_create_social_draft",
    arguments: draftArgs(String(media._id), {
      scheduledFor: "2026-11-21T12:30:00+05:30",
    }),
  });
  assert.notEqual(created.isError, true, created.content?.[0]?.text);
  assert.equal(created.structuredContent.post.status, "draft");
  const fetched = await client.callTool({
    name: "aquakart_get_social_draft",
    arguments: { postId: created.structuredContent.post.postId },
  });
  assert.notEqual(fetched.isError, true, fetched.content?.[0]?.text);
  assert.equal(fetched.structuredContent.post.checks.readyForReview, true);

  const publish = await client.callTool({
    name: "aquakart_publish_social_post",
    arguments: { postId: created.structuredContent.post.postId },
  });
  assert.equal(publish.isError, true, "needs instagram:publish");
});

test("scope and permission wiring: MCP social scopes map to social.* permissions", () => {
  assert.equal(SCOPE_PERMISSIONS["social:read"], "social.read");
  assert.equal(SCOPE_PERMISSIONS["social:write"], "social.manage");
  for (const permission of ["social.read", "social.manage", "social.review"])
    assert.ok(PERMISSIONS.includes(permission), permission);
});

test("CRM controller maps results and errors to HTTP responses", async () => {
  const { social, seedMedia } = setup();
  const media = await seedMedia();
  const { post } = await social.createSocialDraft(
    draftArgs(String(media._id)),
    SOCIAL,
  );
  const controller = createSocialPostController({
    socialTools: social,
    log: { error: () => {} },
  });
  const call = async (handler, { params = {}, body = {}, query = {} } = {}) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    await handler(
      { params, body, query, user: { _id: "64b0000000000000000000bb" } },
      res,
    );
    return res;
  };

  const list = await call(controller.list, { query: { status: "draft" } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.success, true);
  assert.equal(list.body.posts.length, 1);

  const missing = await call(controller.get, {
    params: { id: "64b00000000000000000dead" },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.code, "SOCIAL_POST_NOT_FOUND");

  const early = await call(controller.publish, { params: { id: post.postId } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.body.code, "SOCIAL_POST_NOT_APPROVED");

  const approved = await call(controller.approve, {
    params: { id: post.postId },
    body: { note: "ok" },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.post.status, "approved");
  assert.equal(approved.body.post.review.by, "64b0000000000000000000bb");

  const badEdit = await call(controller.update, {
    params: { id: post.postId },
    body: { caption: "#a ".repeat(40), ignored: "x" },
  });
  assert.equal(badEdit.statusCode, 422);
  assert.equal(badEdit.body.code, "INVALID_CAPTION");
});
