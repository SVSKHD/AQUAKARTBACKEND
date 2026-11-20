import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBlogTools } from "../src/services/mcp/blogTools.js";
import { createAquakartMcpServer } from "../src/services/mcp/server.js";
import { createGoogleDrive } from "../src/services/mcp/googleDrive.js";
import { BlogToolError } from "../src/services/mcp/errors.js";
import { MCP_SCOPES } from "../src/services/mcp/config.js";
import { imageDimensions } from "../src/validators/mcp/blog.js";
import {
  GIF,
  createClock,
  createFakeUploader,
  createMemoryStore,
  ctxFor,
  runnerFor,
  testConfig,
} from "./support/mcpFakes.js";

// aquakart_import_blog_banner with in-memory MongoDB/Cloudinary fakes and
// a scriptable Google Drive. No network.

const FOLDER = "folderBanners0001";
const SUBFOLDER = "folderBannersSub01";
const OTHER_FOLDER = "folderSomewhereElse";
const DRIVE_ENV = {
  GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL:
    "banner-importer@aquakart-test.iam.gserviceaccount.com",
  GOOGLE_DRIVE_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----",
  GOOGLE_DRIVE_BANNER_FOLDER_IDS: FOLDER,
};
const WRITE = ctxFor([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.upload]);

// Minimal but well-formed image headers with real dimensions.
export const pngOf = (width, height, seed = randomBytes(8)) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.from(seed),
  ]);
};
const jpegOf = (width, height) => {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, randomBytes(8)]);
};
const webpVp8xOf = (width, height) => {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(32, 4);
  buffer.write("WEBPVP8X", 8, "latin1");
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
};

// Scriptable Drive: files by id; unknown ids are "not found", `denied` ids
// answer like a file the service account may not read.
const createFakeDrive = () => {
  const drive = {
    configured: true,
    shareWith: DRIVE_ENV.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL,
    files: new Map([
      [FOLDER, { id: FOLDER, parents: ["rootFolder000001"] }],
      [SUBFOLDER, { id: SUBFOLDER, parents: [FOLDER] }],
      [OTHER_FOLDER, { id: OTHER_FOLDER, parents: [] }],
    ]),
    bytes: new Map(),
    denied: new Set(),
    calls: { getFile: 0, download: 0 },
    add(id, buffer, meta = {}) {
      drive.files.set(id, {
        id,
        name: `${id}.png`,
        mimeType: "image/png",
        size: String(buffer.length),
        md5Checksum: `md5-${id}-${buffer.length}`,
        version: "3",
        trashed: false,
        parents: [FOLDER],
        ...meta,
      });
      drive.bytes.set(id, buffer);
    },
    async getFile(id) {
      drive.calls.getFile += 1;
      if (drive.denied.has(id))
        throw new BlogToolError("DRIVE_ACCESS_DENIED", "denied", {
          shareWith: drive.shareWith,
        });
      const file = drive.files.get(id);
      if (!file) throw new BlogToolError("DRIVE_FILE_NOT_FOUND", "not found");
      return structuredClone(file);
    },
    async download(id, { maxBytes }) {
      drive.calls.download += 1;
      const buffer = drive.bytes.get(id);
      if (buffer.length > maxBytes)
        throw new BlogToolError("IMAGE_TOO_LARGE", "too large");
      return Buffer.from(buffer);
    },
  };
  return drive;
};

const setup = (envOverrides = {}) => {
  const clock = createClock();
  const store = createMemoryStore(clock);
  const uploader = createFakeUploader();
  uploader.uploadCount = 0;
  const realUpload = uploader.uploadImage;
  uploader.uploadImage = async (...args) => {
    uploader.uploadCount += 1;
    return realUpload(...args);
  };
  uploader.brandedUrl = (publicId, _config, variant) =>
    `https://res.cloudinary.com/demo/image/upload/l_logo_${variant}/${publicId}`;
  const drive = createFakeDrive();
  const audits = [];
  const logs = [];
  const config = testConfig({ ...DRIVE_ENV, ...envOverrides });
  const tools = createBlogTools({
    store,
    uploader,
    drive,
    runOperation: runnerFor(store, clock),
    config,
    now: clock.now,
    audit: async (entry) => audits.push(entry),
    log: { log: (line) => logs.push(line), error: () => {} },
  });
  return { clock, store, uploader, drive, tools, audits, logs, config };
};

const createDraft = async (tools, key = "draft-banner-01") =>
  (
    await tools.createBlog(
      {
        idempotencyKey: key,
        title: `Hard Water and Your Dog's Coat ${key}`,
        description: `<p>${"Hard water can dry out skin and coats. ".repeat(10)}${key}</p>`,
      },
      WRITE,
    )
  ).blog;

const importArgs = (blog, overrides = {}) => ({
  blogId: blog.blogId,
  source: { type: "google_drive", fileId: "bannerFile000001" },
  ...overrides,
});

const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) =>
      error.code === code ||
      assert.fail(`expected ${code}, got ${error.code}: ${error.message}`),
  );

test("imports a Drive banner, overlays the logo, attaches it and verifies by reading back", async () => {
  const { tools, store, drive, audits, logs } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));

  const result = await tools.importBlogBanner(
    importArgs(blog, {
      expectedRevision: blog.revision,
      altText: "Dog drinking softened water",
    }),
    WRITE,
  );

  assert.equal(result.blogId, blog.blogId);
  assert.match(result.mediaId, /^[a-f0-9]{24}$/);
  assert.match(result.imageUrl, /l_logo_original\/Blogs\/mcp_[a-f0-9]{32}$/);
  assert.equal(result.logo.applied, true);
  assert.equal(result.logo.decidedBy, "default");
  assert.equal(result.alreadyAttached, false);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.verification, {
    status: "verified",
    hasTitleImage: true,
    titleImageCount: 1,
    matchesImportedMedia: true,
  });
  assert.equal(result.blog.hasTitleImage, true);
  assert.equal(result.titleImageAlt, "Dog drinking softened water");
  assert.notEqual(result.revision, blog.revision);
  assert.deepEqual(result.source, {
    type: "google_drive",
    fileId: "bannerFile000001",
    name: "bannerFile000001.png",
    version: "md5-bannerFile000001-41",
  });

  const saved = store.blogs[0];
  assert.equal(saved.status, "draft", "never published");
  assert.equal(saved.titleImages.length, 1);
  assert.match(
    saved.description,
    /Hard water can dry out/,
    "content untouched",
  );
  assert.equal(store.media.length, 1);
  assert.equal(store.media[0].source, "google-drive");
  assert.equal(store.media[0].sourceRef.fileId, "bannerFile000001");
  assert.equal(String(store.media[0].blog), blog.blogId);
  assert.ok(audits.some((a) => a.action === "mcp.blog.import_banner"));

  const line = JSON.parse(logs.at(-1));
  assert.equal(line.event, "mcp.blog.import_banner");
  assert.equal(line.ok, true);
  assert.equal(line.correlationId, "test-correlation-id");
  assert.doesNotMatch(logs.join("\n"), /PRIVATE KEY|access_token/);
});

test("folder rules: subfolders are allowed, other folders and unshared files are refused", async () => {
  const { tools, drive, uploader } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerInSubfolder", pngOf(1200, 630), { parents: [SUBFOLDER] });
  drive.add("bannerElsewhere01", pngOf(1200, 630), { parents: [OTHER_FOLDER] });
  drive.add("bannerNoAccess001", pngOf(1200, 630));
  drive.denied.add("bannerNoAccess001");

  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerElsewhere01" },
      }),
      WRITE,
    ),
    "DRIVE_FOLDER_NOT_ALLOWED",
  );
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerNoAccess001" },
      }),
      WRITE,
    ),
    "DRIVE_ACCESS_DENIED",
  );
  assert.equal(drive.calls.download, 0);
  assert.equal(uploader.uploadCount, 0);

  const ok = await tools.importBlogBanner(
    importArgs(blog, {
      source: { type: "google_drive", fileId: "bannerInSubfolder" },
    }),
    WRITE,
  );
  assert.equal(ok.verification.status, "verified");
});

test("an unknown, trashed or malformed file id is reported clearly", async () => {
  const { tools, drive } = setup();
  const blog = await createDraft(tools);
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "doesNotExist0001" },
      }),
      WRITE,
    ),
    "DRIVE_FILE_NOT_FOUND",
  );
  drive.add("bannerTrashed001", pngOf(1200, 630), { trashed: true });
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerTrashed001" },
      }),
      WRITE,
    ),
    "DRIVE_FILE_NOT_FOUND",
  );

  // The real client refuses a malformed id before any network call.
  const realDrive = createGoogleDrive(
    { ...testConfig(DRIVE_ENV).drive, requestTimeoutMs: 1000 },
    {
      fetchImpl: async () => assert.fail("must not call Google for a bad id"),
    },
  );
  await rejects(realDrive.getFile("../../etc/passwd"), "DRIVE_FILE_NOT_FOUND");
});

test("unsupported formats are refused from Drive metadata and from the real bytes", async () => {
  const { tools, drive, uploader, store } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerGif00000001", GIF, { mimeType: "image/gif" });
  drive.add("bannerFakePng0001", GIF); // claims image/png, bytes are GIF
  drive.add("bannerPdf00000001", Buffer.from("%PDF-1.7 ..."), {
    mimeType: "application/pdf",
  });
  for (const fileId of [
    "bannerGif00000001",
    "bannerFakePng0001",
    "bannerPdf00000001",
  ]) {
    await rejects(
      tools.importBlogBanner(
        importArgs(blog, {
          source: { type: "google_drive", fileId },
          idempotencyKey: `fmt-${fileId}`,
        }),
        WRITE,
      ),
      "UNSUPPORTED_IMAGE_TYPE",
    );
  }
  assert.equal(uploader.uploadCount, 0);
  assert.equal(store.blogs[0].titleImages.length, 0);
});

test("files over the size limit or outside the dimension bounds are refused", async () => {
  const { tools, drive, uploader } = setup({ MCP_IMAGE_MAX_BYTES: "1000" });
  const blog = await createDraft(tools);
  drive.add("bannerHuge0000001", pngOf(1600, 840, randomBytes(2000)));
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerHuge0000001" },
      }),
      WRITE,
    ),
    "IMAGE_TOO_LARGE",
  );
  assert.equal(drive.calls.download, 0, "refused from Drive's declared size");

  // Drive under-reports the size: the download cap still stops it.
  drive.add("bannerLiar0000001", pngOf(1600, 840, randomBytes(2000)), {
    size: "500",
  });
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerLiar0000001" },
      }),
      WRITE,
    ),
    "IMAGE_TOO_LARGE",
  );

  drive.add("bannerTiny0000001", pngOf(300, 200));
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerTiny0000001" },
      }),
      WRITE,
    ),
    "IMAGE_DIMENSIONS_INVALID",
  );
  assert.equal(uploader.uploadCount, 0);
});

test("an existing banner is kept unless replaceExisting is true", async () => {
  const { tools, drive, store, uploader } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));
  drive.add("bannerSecond00001", pngOf(1600, 840));
  const first = await tools.importBlogBanner(importArgs(blog), WRITE);

  await rejects(
    tools.importBlogBanner(
      importArgs(blog, {
        source: { type: "google_drive", fileId: "bannerSecond00001" },
      }),
      WRITE,
    ),
    "BANNER_EXISTS",
  );
  assert.equal(store.blogs[0].titleImages[0].id, store.media[0].publicId);

  const replaced = await tools.importBlogBanner(
    importArgs(blog, {
      source: { type: "google_drive", fileId: "bannerSecond00001" },
      replaceExisting: true,
    }),
    WRITE,
  );
  assert.notEqual(replaced.mediaId, first.mediaId);
  assert.equal(store.blogs[0].titleImages.length, 1);
  assert.equal(replaced.verification.status, "verified");
  // The replaced MCP image was used nowhere else, so it was released.
  assert.equal(uploader.destroyed.length, 1);
  assert.equal(
    store.media.find((m) => m._id === first.mediaId).status,
    "deleted",
  );
});

test("a stale expectedRevision or a non-draft blog is refused before downloading", async () => {
  const { tools, drive, store } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, { expectedRevision: "2020-01-01T00:00:00.000Z" }),
      WRITE,
    ),
    "REVISION_CONFLICT",
  );
  store.blogs[0].status = "published";
  await rejects(
    tools.importBlogBanner(
      importArgs(blog, { idempotencyKey: "import-live-blog" }),
      WRITE,
    ),
    "BLOG_NOT_DRAFT",
  );
  assert.equal(drive.calls.download, 0);
  assert.equal(store.blogs[0].titleImages.length, 0);
});

test("repeating an import replays it, and a new call for the same file is a no-op", async () => {
  const { tools, drive, store, uploader } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));
  const first = await tools.importBlogBanner(importArgs(blog), WRITE);

  // Identical call, no key: the derived key makes it a replay.
  const again = await tools.importBlogBanner(importArgs(blog), WRITE);
  assert.equal(again.replayed, true);
  assert.equal(again.operationId, first.operationId);

  // Different key, same file version: recognised as already attached
  // (no download, no upload, no BANNER_EXISTS).
  const fresh = await tools.importBlogBanner(
    importArgs(blog, { idempotencyKey: "import-banner-second" }),
    WRITE,
  );
  assert.equal(fresh.alreadyAttached, true);
  assert.equal(fresh.mediaId, first.mediaId);
  assert.equal(fresh.verification.status, "verified");
  assert.equal(drive.calls.download, 1);
  assert.equal(uploader.uploadCount, 1);
  assert.equal(store.blogs[0].titleImages.length, 1);
  assert.equal(store.media.length, 1);
});

test("a Cloudinary failure leaves the draft unchanged and the same key can retry", async () => {
  const { tools, drive, store, uploader } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));
  const working = uploader.uploadImage;
  uploader.uploadImage = async () => {
    throw Object.assign(new Error("Cloudinary 503"), { http_code: 503 });
  };
  const args = importArgs(blog, { idempotencyKey: "import-banner-retry" });
  await assert.rejects(tools.importBlogBanner(args, WRITE), (error) => {
    assert.equal(error.code, "IMAGE_STORAGE_FAILED");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /cloudinary 503/i);
    return true;
  });
  assert.equal(store.blogs[0].titleImages.length, 0);
  assert.equal(store.media.length, 0);

  uploader.uploadImage = working;
  const retried = await tools.importBlogBanner(args, WRITE);
  assert.equal(retried.verification.status, "verified");
  assert.equal(store.blogs[0].titleImages.length, 1);
});

test("concurrent imports attach exactly one image", async () => {
  const { tools, drive, store } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));

  // Same derived key: one runs, the other is told it is in progress.
  const sameKey = await Promise.allSettled([
    tools.importBlogBanner(importArgs(blog), WRITE),
    tools.importBlogBanner(importArgs(blog), WRITE),
  ]);
  const fulfilled = sameKey.filter((r) => r.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);
  for (const r of sameKey.filter((x) => x.status === "rejected"))
    assert.equal(r.reason.code, "OPERATION_IN_PROGRESS");
  assert.equal(store.blogs[0].titleImages.length, 1);

  // Different keys racing to replace with the same new file.
  drive.add("bannerSecond00001", pngOf(1600, 840));
  const raced = await Promise.allSettled(
    ["race-key-a", "race-key-b"].map((idempotencyKey) =>
      tools.importBlogBanner(
        importArgs(blog, {
          idempotencyKey,
          replaceExisting: true,
          source: { type: "google_drive", fileId: "bannerSecond00001" },
        }),
        WRITE,
      ),
    ),
  );
  for (const r of raced) {
    if (r.status === "rejected")
      assert.equal(r.reason.code, "REVISION_CONFLICT");
  }
  assert.ok(raced.some((r) => r.status === "fulfilled"));
  assert.equal(store.blogs[0].titleImages.length, 1);
  const active = store.media.filter((m) => m.status === "active");
  assert.equal(
    active.filter((m) => m.sourceRef.fileId === "bannerSecond00001").length,
    1,
  );
});

test("logo policy follows the caller, then Drive metadata, never the pixels", async () => {
  const { tools, drive } = setup();
  const cases = [
    { meta: {}, args: {}, expect: ["original", "default"] },
    {
      meta: { properties: { aquakartLogo: "present" } },
      args: {},
      expect: [null, "drive-metadata"],
    },
    {
      meta: { appProperties: { aquakartLogo: "white" } },
      args: {},
      expect: ["white", "drive-metadata"],
    },
    {
      meta: { properties: { aquakartLogo: "present" } },
      args: { logoMode: "white" },
      expect: ["white", "caller"],
    },
    { meta: {}, args: { logoMode: "none" }, expect: [null, "caller"] },
  ];
  let n = 0;
  for (const { meta, args, expect } of cases) {
    n += 1;
    const blog = await createDraft(tools, `logo-case-${n}`);
    const fileId = `bannerLogoCase0${n}`;
    drive.add(fileId, pngOf(1600, 840), meta);
    const result = await tools.importBlogBanner(
      importArgs(blog, { source: { type: "google_drive", fileId }, ...args }),
      WRITE,
    );
    assert.equal(result.logo.variant, expect[0], `case ${n}`);
    assert.equal(result.logo.decidedBy, expect[1], `case ${n}`);
    assert.equal(result.logo.applied, Boolean(expect[0]));
    if (expect[0])
      assert.match(result.imageUrl, new RegExp(`l_logo_${expect[0]}/`));
    else assert.equal(result.imageUrl, result.originalImageUrl);
  }

  // Overlays switched off: auto adds nothing, an explicit variant is refused.
  const off = setup({ AQUAKART_LOGO_PUBLIC_ID: "none" });
  const blog = await createDraft(off.tools);
  off.drive.add("bannerFile000001", pngOf(1600, 840));
  await rejects(
    off.tools.importBlogBanner(
      importArgs(blog, { logoMode: "original" }),
      WRITE,
    ),
    "LOGO_NOT_CONFIGURED",
  );
  const auto = await off.tools.importBlogBanner(importArgs(blog), WRITE);
  assert.equal(auto.logo.applied, false);
});

test("without Drive credentials the tool says it is not configured", async () => {
  const { tools } = setup({ GOOGLE_DRIVE_BANNER_FOLDER_IDS: "" });
  const blog = await createDraft(tools);
  await rejects(
    tools.importBlogBanner(importArgs(blog), WRITE),
    "DRIVE_NOT_CONFIGURED",
  );
});

test("the MCP tool enforces blogs:write and media:upload and returns a schema-valid result", async () => {
  const connect = async (scopes, blogTools) => {
    const server = createAquakartMcpServer({
      blogTools,
      instagramTools: {},
      catalogTools: {},
      taxonomySeoTools: {},
      invoiceAuditTools: {},
      invoiceActionTools: {},
      auth: {
        clientId: "mcp_test-client",
        adminUserId: "64b000000000000000000001",
        scopes,
      },
      correlationId: "corr-mcp-test",
      resourceMetadataUrl: "http://localhost/.well-known/x",
      log: { log: () => {}, error: () => {} },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  };

  const { tools, drive } = setup();
  const blog = await createDraft(tools);
  drive.add("bannerFile000001", pngOf(1600, 840));

  let called = 0;
  const spy = {
    ...tools,
    importBlogBanner: (...args) => {
      called += 1;
      return tools.importBlogBanner(...args);
    },
  };
  const readOnly = await connect([MCP_SCOPES.read, MCP_SCOPES.write], spy);
  const denied = await readOnly.callTool({
    name: "aquakart_import_blog_banner",
    arguments: importArgs(blog),
  });
  assert.equal(denied.isError, true);
  const body = JSON.parse(denied.content[0].text);
  assert.equal(body.error.code, "INSUFFICIENT_SCOPE");
  assert.deepEqual(body.error.details.missing, [MCP_SCOPES.upload]);
  assert.equal(called, 0);

  const full = await connect(
    [MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.upload],
    spy,
  );
  const { tools: listed } = await full.listTools();
  const tool = listed.find((t) => t.name === "aquakart_import_blog_banner");
  assert.deepEqual(tool._meta.securitySchemes, [
    { type: "oauth2", scopes: ["blogs:write", "media:upload"] },
  ]);
  assert.equal(tool.inputSchema.additionalProperties, false);

  const ok = await full.callTool({
    name: "aquakart_import_blog_banner",
    arguments: importArgs(blog, { idempotencyKey: "mcp-import-banner-1" }),
  });
  assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
  assert.equal(ok.structuredContent.ok, true);
  assert.equal(ok.structuredContent.blog.hasTitleImage, true);
  assert.equal(ok.structuredContent.verification.status, "verified");

  const bad = await full.callTool({
    name: "aquakart_import_blog_banner",
    arguments: {
      ...importArgs(blog),
      source: { type: "url", url: "http://169.254.169.254/" },
    },
  });
  assert.equal(bad.isError, true, "only google_drive sources are accepted");
});

test("image dimensions are read from PNG, JPEG and WebP headers", () => {
  assert.deepEqual(imageDimensions(pngOf(1600, 840), "png"), {
    width: 1600,
    height: 840,
  });
  assert.deepEqual(imageDimensions(jpegOf(1920, 1005), "jpg"), {
    width: 1920,
    height: 1005,
  });
  assert.deepEqual(imageDimensions(webpVp8xOf(1200, 630), "webp"), {
    width: 1200,
    height: 630,
  });
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "jpg"), null);
});

test("the Drive client signs a service-account token, maps Google errors and caps downloads", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const requests = [];
  const answers = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith("https://oauth2.googleapis.com/token"))
      return new Response(
        JSON.stringify({ access_token: "ya29.secret-token", expires_in: 3600 }),
        { status: 200 },
      );
    return answers.shift()();
  };
  const drive = createGoogleDrive(
    {
      configured: true,
      clientEmail: DRIVE_ENV.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL,
      privateKey: pem,
      folderIds: [FOLDER],
      folderDepth: 5,
      requestTimeoutMs: 1000,
    },
    { fetchImpl },
  );

  answers.push(
    () =>
      new Response(JSON.stringify({ id: "bannerFile000001" }), { status: 200 }),
  );
  assert.equal(
    (await drive.getFile("bannerFile000001")).id,
    "bannerFile000001",
  );
  const tokenBody = new URLSearchParams(String(requests[0].init.body));
  assert.equal(
    tokenBody.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const claims = JSON.parse(
    Buffer.from(tokenBody.get("assertion").split(".")[1], "base64url"),
  );
  assert.equal(claims.scope, "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(claims.iss, DRIVE_ENV.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL);
  assert.match(requests[1].url, /supportsAllDrives=true/);
  assert.equal(
    requests[1].init.headers.authorization,
    "Bearer ya29.secret-token",
  );

  const errorFor = async (status, reason) => {
    answers.push(
      () =>
        new Response(JSON.stringify({ error: { errors: [{ reason }] } }), {
          status,
        }),
    );
    try {
      await drive.getFile("bannerFile000001");
    } catch (error) {
      assert.doesNotMatch(
        JSON.stringify(error) + error.message,
        /ya29|PRIVATE/,
      );
      return error;
    }
    return assert.fail("expected an error");
  };
  assert.equal((await errorFor(404, "notFound")).code, "DRIVE_FILE_NOT_FOUND");
  assert.equal((await errorFor(403, "forbidden")).code, "DRIVE_ACCESS_DENIED");
  const busy = await errorFor(503, "backendError");
  assert.equal(busy.code, "DRIVE_UNAVAILABLE");
  assert.equal(busy.retryable, true);
  assert.equal(
    (await errorFor(403, "userRateLimitExceeded")).code,
    "DRIVE_UNAVAILABLE",
  );

  // Streams past the cap are cut off even without a content-length.
  answers.push(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(400));
          },
        }),
        { status: 200 },
      ),
  );
  await rejects(
    drive.download("bannerFile000001", { maxBytes: 1000 }),
    "IMAGE_TOO_LARGE",
  );
  answers.push(() => new Response(pngOf(1200, 630), { status: 200 }));
  const bytes = await drive.download("bannerFile000001", { maxBytes: 5000 });
  assert.deepEqual(imageDimensions(bytes, "png"), { width: 1200, height: 630 });
  assert.equal(
    requests.filter((r) => r.url.startsWith("https://oauth2")).length,
    1,
    "token is cached",
  );
});
