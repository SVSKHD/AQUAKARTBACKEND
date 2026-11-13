import test from "node:test";
import assert from "node:assert/strict";
import { createBlogTools } from "../src/services/mcp/blogTools.js";
import { sanitizeBlogHtml } from "../src/validators/mcp/blog.js";
import {
  hostAllowed,
  isPublicAddress,
  readImageInput,
} from "../src/services/mcp/imageInput.js";
import { MCP_SCOPES } from "../src/services/mcp/config.js";
import {
  GIF,
  PNG,
  createClock,
  createFakeUploader,
  createMemoryStore,
  ctxFor,
  objectId,
  runnerFor,
  testConfig,
} from "./support/mcpFakes.js";

const article = (words = 40) =>
  `<h2>Why it matters</h2><p>${"Hard water leaves scale on taps and heaters. ".repeat(Math.ceil(words / 8))}</p>`;
const WRITE = ctxFor([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.upload]);
const PUBLISH = ctxFor([
  MCP_SCOPES.read,
  MCP_SCOPES.write,
  MCP_SCOPES.upload,
  MCP_SCOPES.publish,
]);

const setup = (configOverrides) => {
  const clock = createClock();
  const store = createMemoryStore(clock);
  const uploader = createFakeUploader();
  const audits = [];
  const config = testConfig(configOverrides);
  const tools = createBlogTools({
    store,
    uploader,
    runOperation: runnerFor(store, clock),
    config,
    now: clock.now,
    audit: async (entry) => audits.push(entry),
  });
  return { clock, store, uploader, tools, audits, config };
};

const draftArgs = (overrides = {}) => ({
  idempotencyKey: "blog-2026-11-06",
  title: "How to Choose a Water Softener for Your Home",
  description: article(),
  shortDescription:
    "A practical guide to choosing the right water softener for Indian homes with hard borewell water.",
  keywords: ["water softener", "hard water", "water softener"],
  tags: ["Water Softeners"],
  ...overrides,
});

const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) =>
      error.code === code ||
      assert.fail(`expected ${code}, got ${error.code}: ${error.message}`),
  );

test("create saves a sanitized draft with MCP provenance and is audited", async () => {
  const { tools, store, audits } = setup();
  const result = await tools.createBlog(
    draftArgs({
      description: `${article()}<script>alert(1)</script><img src=x onerror=alert(1)><h1>Big</h1><a href="javascript:alert(1)">x</a>`,
    }),
    WRITE,
  );
  assert.equal(result.blog.status, "draft");
  assert.equal(
    result.blog.slug,
    "how-to-choose-a-water-softener-for-your-home",
  );
  assert.equal(result.replayed, false);
  assert.match(result.operationId, /^op_/);
  assert.deepEqual(result.warnings, ["HTML_SANITIZED"]);
  const saved = store.blogs[0];
  assert.equal(saved.status, "draft");
  assert.equal(saved.generatedBy, "ai");
  assert.deepEqual(saved.titleImages, []);
  assert.doesNotMatch(
    saved.description,
    /script|onerror|<img|<h1|javascript:/i,
  );
  assert.match(saved.description, /<h2>Big<\/h2>/);
  assert.equal(saved.keywords, "water softener, hard water");
  assert.equal(saved.integration.source, "mcp");
  assert.equal(saved.integration.createdByOperation, result.operationId);
  assert.equal(audits[0].action, "mcp.blog.create");
});

test("the sanitizer keeps article structure and safe links only", () => {
  const html = sanitizeBlogHtml(
    '<p style="color:red" onclick="x()">Hi <a href="https://aquakart.co.in/products" target="_blank">shop</a> <a href="//evil.example">p</a></p><iframe src="https://evil"></iframe><table><tr><td colspan="2">ok</td></tr></table>',
  );
  assert.equal(
    html,
    '<p>Hi <a href="https://aquakart.co.in/products" target="_blank" rel="noopener noreferrer">shop</a> <a>p</a></p><table><tr><td colspan="2">ok</td></tr></table>',
  );
});

test("retrying with the same idempotencyKey replays the result without a second blog", async () => {
  const { tools, store } = setup();
  const first = await tools.createBlog(draftArgs(), WRITE);
  const again = await tools.createBlog(draftArgs(), WRITE);
  assert.equal(again.replayed, true);
  assert.equal(again.operationId, first.operationId);
  assert.equal(again.blog.blogId, first.blog.blogId);
  assert.equal(store.blogs.length, 1);
  assert.equal(store.calls.createBlog, 1);
  // Same key, different arguments: refused, not silently applied.
  await rejects(
    tools.createBlog(
      draftArgs({ title: "A Completely Different Article Title" }),
      WRITE,
    ),
    "IDEMPOTENCY_KEY_REUSED",
  );
});

test("duplicate content, duplicate titles and taken slugs are rejected", async () => {
  const { tools } = setup();
  await tools.createBlog(draftArgs({ slug: "choose-water-softener" }), WRITE);
  await rejects(
    tools.createBlog(draftArgs({ idempotencyKey: "blog-dup-content" }), WRITE),
    "DUPLICATE_CONTENT",
  );
  await rejects(
    tools.createBlog(
      draftArgs({ idempotencyKey: "blog-dup-title", description: article(60) }),
      WRITE,
    ),
    "DUPLICATE_TITLE",
  );
  await rejects(
    tools.createBlog(
      draftArgs({
        idempotencyKey: "blog-dup-slug",
        title: "Another Softener Guide For Homes",
        description: article(80),
        slug: "choose-water-softener",
      }),
      WRITE,
    ),
    "SLUG_TAKEN",
  );
  // A derived slug is suffixed instead of failing.
  const derived = await tools.createBlog(
    draftArgs({
      idempotencyKey: "blog-derived",
      title: "Choose Water Softener",
      description: article(90),
    }),
    WRITE,
  );
  assert.equal(derived.blog.slug, "choose-water-softener-2");
  assert.ok(derived.warnings.includes("SLUG_ADJUSTED"));
});

test("invalid category/product references are rejected before saving", async () => {
  const { tools, store } = setup();
  await rejects(
    tools.createBlog(draftArgs({ category: objectId() }), WRITE),
    "INVALID_REFERENCE",
  );
  await rejects(
    tools.createBlog(
      draftArgs({ idempotencyKey: "blog-bad-product", product: objectId() }),
      WRITE,
    ),
    "INVALID_REFERENCE",
  );
  assert.equal(store.blogs.length, 0);
});

test("updates edit drafts only, keep images, and detect stale revisions", async () => {
  const { tools, store } = setup();
  const { blog } = await tools.createBlog(draftArgs(), WRITE);
  store.blogs[0].titleImages = [
    {
      id: "Blogs/staff_image",
      secure_url: "https://res.cloudinary.com/demo/staff.png",
    },
  ];
  const updated = await tools.updateBlog(
    {
      idempotencyKey: "blog-edit-1",
      blogId: blog.blogId,
      summary: "Updated summary",
      expectedRevision: blog.revision,
    },
    WRITE,
  );
  assert.notEqual(updated.blog.revision, blog.revision);
  assert.equal(store.blogs[0].summary, "Updated summary");
  assert.deepEqual(store.blogs[0].titleImages, [
    {
      id: "Blogs/staff_image",
      secure_url: "https://res.cloudinary.com/demo/staff.png",
    },
  ]);
  assert.equal(store.blogs[0].title, blog.title);

  await rejects(
    tools.updateBlog(
      {
        idempotencyKey: "blog-edit-2",
        blogId: blog.blogId,
        summary: "x",
        expectedRevision: blog.revision,
      },
      WRITE,
    ),
    "REVISION_CONFLICT",
  );
  store.blogs[0].status = "published";
  await rejects(
    tools.updateBlog(
      { idempotencyKey: "blog-edit-3", blogId: blog.blogId, summary: "y" },
      WRITE,
    ),
    "BLOG_NOT_DRAFT",
  );
});

test("image upload verifies bytes, de-duplicates, and refuses untrusted sources", async () => {
  const { tools, store } = setup();
  const first = await tools.uploadImage(
    { idempotencyKey: "img-0001", imageBase64: PNG.toString("base64") },
    WRITE,
  );
  assert.equal(first.deduplicated, false);
  assert.match(first.media.publicId, /^Blogs\/mcp_[a-f0-9]{32}$/);
  const second = await tools.uploadImage(
    { idempotencyKey: "img-0002", imageBase64: PNG.toString("base64") },
    WRITE,
  );
  assert.equal(second.deduplicated, true);
  assert.equal(second.media.mediaId, first.media.mediaId);
  assert.equal(store.media.length, 1);

  await rejects(
    tools.uploadImage(
      { idempotencyKey: "img-0003", imageBase64: GIF.toString("base64") },
      WRITE,
    ),
    "UNSUPPORTED_IMAGE_TYPE",
  );
  await rejects(
    readImageInput(
      {
        image: {
          download_url: "https://evil.example.com/a.png",
          file_id: "file_1",
        },
      },
      { maxBytes: 1000, trustedHosts: ["*.oaiusercontent.com"] },
    ),
    "UNTRUSTED_IMAGE_SOURCE",
  );
  await rejects(
    readImageInput(
      {
        image: {
          download_url: "http://files.oaiusercontent.com/a.png",
          file_id: "file_1",
        },
      },
      { maxBytes: 1000, trustedHosts: ["*.oaiusercontent.com"] },
    ),
    "UNTRUSTED_IMAGE_SOURCE",
  );
  await rejects(
    readImageInput(
      { imageBase64: PNG.toString("base64") },
      { maxBytes: 10, trustedHosts: [] },
    ),
    "IMAGE_TOO_LARGE",
  );
  assert.equal(
    hostAllowed("files.oaiusercontent.com", ["*.oaiusercontent.com"]),
    true,
  );
  assert.equal(
    hostAllowed("oaiusercontent.com.evil.io", ["*.oaiusercontent.com"]),
    false,
  );
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("104.18.32.1"), true);
});

test("ChatGPT file params download through the trusted downloader", async () => {
  const { tools, uploader } = setup();
  const seen = [];
  uploader.download = async (url, options) => {
    seen.push({ url, hosts: options.trustedHosts });
    return PNG;
  };
  const result = await tools.uploadImage(
    {
      idempotencyKey: "img-file-1",
      image: {
        download_url: "https://files.oaiusercontent.com/file-abc?sig=secret",
        file_id: "file-abc",
      },
    },
    WRITE,
  );
  assert.equal(result.deduplicated, false);
  assert.equal(
    seen[0].url,
    "https://files.oaiusercontent.com/file-abc?sig=secret",
  );
  assert.deepEqual(seen[0].hosts, ["*.oaiusercontent.com"]);
});

test("attach sets the title image, publish runs checks, and repeat publishes are no-ops", async () => {
  // Logo overlays switched off: applyBrandLogo is refused.
  const { tools, store } = setup({ AQUAKART_LOGO_PUBLIC_ID: "none" });
  const { blog } = await tools.createBlog(draftArgs(), PUBLISH);
  await rejects(
    tools.publishBlog(
      { idempotencyKey: "pub-0001", blogId: blog.blogId },
      PUBLISH,
    ),
    "PUBLISH_CHECKS_FAILED",
  );

  const { media } = await tools.uploadImage(
    { idempotencyKey: "img-0001", imageBase64: PNG.toString("base64") },
    PUBLISH,
  );
  const attached = await tools.attachImage(
    {
      idempotencyKey: "attach-0001",
      blogId: blog.blogId,
      mediaId: media.mediaId,
    },
    PUBLISH,
  );
  assert.deepEqual(attached.titleImage, {
    id: media.publicId,
    secure_url: media.secure_url,
  });
  assert.equal(store.media[0].blog, store.blogs[0]._id);
  await rejects(
    tools.attachImage(
      {
        idempotencyKey: "attach-0002",
        blogId: blog.blogId,
        mediaId: media.mediaId,
        applyBrandLogo: true,
      },
      PUBLISH,
    ),
    "LOGO_NOT_CONFIGURED",
  );

  const published = await tools.publishBlog(
    { idempotencyKey: "pub-0002", blogId: blog.blogId },
    PUBLISH,
  );
  assert.equal(published.alreadyPublished, false);
  assert.equal(published.blog.status, "published");
  assert.equal(
    published.publicUrl,
    "https://aquakart.co.in/blog/how-to-choose-a-water-softener-for-your-home",
  );
  assert.equal(published.visibleOnStorefront, true);
  assert.equal(
    store.blogs[0].integration.publishedBy,
    PUBLISH.auth.adminUserId,
  );

  const repeat = await tools.publishBlog(
    { idempotencyKey: "pub-0003", blogId: blog.blogId },
    PUBLISH,
  );
  assert.equal(repeat.alreadyPublished, true);
  const status = await tools.getBlogStatus({ blogId: blog.blogId });
  assert.equal(status.status, "published");
  assert.equal(status.visibleOnStorefront, true);
});

test("branded title images use the stored logo", async () => {
  const { tools } = setup({ AQUAKART_LOGO_PUBLIC_ID: "brand/aquakart-logo" });
  const { blog } = await tools.createBlog(draftArgs(), WRITE);
  const { media } = await tools.uploadImage(
    { idempotencyKey: "img-0001", imageBase64: PNG.toString("base64") },
    WRITE,
  );
  const attached = await tools.attachImage(
    {
      idempotencyKey: "attach-1",
      blogId: blog.blogId,
      mediaId: media.mediaId,
      applyBrandLogo: true,
    },
    WRITE,
  );
  assert.match(attached.titleImage.secure_url, /l_logo/);
});

test("the official logo is the default overlay and brand assets describe it", async () => {
  const { tools, uploader, config } = setup();
  assert.equal(config.logoPublicId, "logo_nt2v92");
  assert.equal(config.logoWhitePublicId, "logo-white_rpvptt");
  const variants = [];
  uploader.brandedUrl = (publicId, _config, variant) => {
    variants.push(variant);
    return `https://res.cloudinary.com/demo/image/upload/l_${variant}/${publicId}`;
  };
  const { blog } = await tools.createBlog(draftArgs(), WRITE);
  const { media } = await tools.uploadImage(
    { idempotencyKey: "img-0001", imageBase64: PNG.toString("base64") },
    WRITE,
  );
  await tools.attachImage(
    {
      idempotencyKey: "attach-white-1",
      blogId: blog.blogId,
      mediaId: media.mediaId,
      applyBrandLogo: true,
      logoVariant: "white",
    },
    WRITE,
  );
  assert.deepEqual(variants, ["white"]);

  const { brand } = tools.getBrandAssets();
  assert.deepEqual(
    brand.logos.map((logo) => [logo.variant, logo.url]),
    [
      [
        "original",
        "https://res.cloudinary.com/aquakartproducts/image/upload/v1793926813/logo_nt2v92.png",
      ],
      [
        "white",
        "https://res.cloudinary.com/aquakartproducts/image/upload/v1793926813/logo-white_rpvptt.png",
      ],
    ],
  );
  assert.match(brand.logos[1].previewUrl, /r_max,bo_5px_solid_red/);
  assert.equal(brand.overlay.available, true);
  assert.ok(brand.rules.some((rule) => /Never redraw/.test(rule)));
});

test("changing a live blog's image needs blogs:publish", async () => {
  const { tools, store } = setup();
  const { blog } = await tools.createBlog(draftArgs(), WRITE);
  const { media } = await tools.uploadImage(
    { idempotencyKey: "img-0001", imageBase64: PNG.toString("base64") },
    WRITE,
  );
  store.blogs[0].status = "published";
  await rejects(
    tools.attachImage(
      {
        idempotencyKey: "attach-1",
        blogId: blog.blogId,
        mediaId: media.mediaId,
      },
      WRITE,
    ),
    "INSUFFICIENT_SCOPE",
  );
});

test("lists and reads drafts and published blogs", async () => {
  const { tools, store } = setup();
  await tools.createBlog(draftArgs(), WRITE);
  store.blogs.push({
    _id: objectId(),
    title: "Staff Blog About RO Filters",
    slug: "staff-ro",
    status: undefined,
    description: "<p>x</p>",
    createdAt: new Date(),
  });
  const all = await tools.listBlogs({ status: "all" });
  assert.equal(all.total, 2);
  assert.equal((await tools.listBlogs({ status: "draft" })).total, 1);
  const published = await tools.listBlogs({ status: "published" });
  assert.equal(published.blogs[0].status, "published"); // legacy blogs without status are live
  const read = await tools.getBlog({ slug: "staff-ro" });
  assert.equal(read.blog.title, "Staff Blog About RO Filters");
  await rejects(tools.getBlog({ slug: "missing" }), "BLOG_NOT_FOUND");
});

test("upload URLs: one success per URL, expiry, owner-only status, and type/size checks", async () => {
  const { clock, store, tools, audits, config } = setup();
  const { upload } = await tools.createImageUpload({}, WRITE);
  const token = upload.uploadUrl.split("/uploads/")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(
    store.uploads.every((u) => !JSON.stringify(u).includes(token)),
    "only the token hash is stored",
  );
  assert.equal(upload.maxBytes, config.imageMaxBytes);

  // Wrong type and empty body are rejected; the URL stays usable.
  await assert.rejects(
    tools.completeImageUpload(token, GIF),
    (e) => e.code === "UNSUPPORTED_IMAGE_TYPE",
  );
  await assert.rejects(
    tools.completeImageUpload(token, Buffer.alloc(0)),
    (e) => e.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    tools.completeImageUpload(token, Buffer.alloc(config.imageMaxBytes + 1)),
    (e) => e.code === "IMAGE_TOO_LARGE",
  );
  const done = await tools.completeImageUpload(token, PNG, {
    correlationId: "c-1",
  });
  assert.equal(done.deduplicated, false);
  assert.equal(store.media[0].source, "upload-url");
  assert.equal(audits.at(-1).action, "mcp.media.upload");
  await assert.rejects(
    tools.completeImageUpload(token, PNG),
    (e) => e.code === "UPLOAD_ALREADY_USED",
  );

  // Status is only visible to the staff member who created the URL.
  const mine = await tools.getImageUpload({ uploadId: upload.uploadId }, WRITE);
  assert.equal(mine.upload.status, "uploaded");
  assert.equal(mine.media.mediaId, done.media.mediaId);
  await assert.rejects(
    tools.getImageUpload(
      { uploadId: upload.uploadId },
      ctxFor([MCP_SCOPES.upload], { adminUserId: objectId() }),
    ),
    (e) => e.code === "UPLOAD_NOT_FOUND",
  );

  // Same bytes again through a new URL are de-duplicated.
  const second = await tools.createImageUpload({}, WRITE);
  const again = await tools.completeImageUpload(
    second.upload.uploadUrl.split("/uploads/")[1],
    PNG,
  );
  assert.equal(again.deduplicated, true);
  assert.equal(again.media.mediaId, done.media.mediaId);

  // Expired URLs are refused and reported as expired.
  const third = await tools.createImageUpload({}, WRITE);
  clock.advance((config.uploadUrlTtlSeconds + 1) * 1000);
  await assert.rejects(
    tools.completeImageUpload(
      third.upload.uploadUrl.split("/uploads/")[1],
      PNG,
    ),
    (e) => e.code === "UPLOAD_NOT_FOUND",
  );
  assert.equal(
    (await tools.getImageUpload({ uploadId: third.upload.uploadId }, WRITE))
      .upload.status,
    "expired",
  );
  await assert.rejects(
    tools.completeImageUpload("not-a-token", PNG),
    (e) => e.code === "UPLOAD_NOT_FOUND",
  );
});

test("adminUrl comes only from a configured https template; alt text round-trips", async () => {
  const unset = setup();
  const plain = await unset.tools.createBlog(draftArgs(), WRITE);
  assert.equal(plain.blog.adminUrl, null);

  const bad = setup({ MCP_ADMIN_BLOG_URL: "http://admin.example/blogs/{id}" });
  assert.equal(
    bad.config.adminBlogUrl,
    null,
    "non-https templates are ignored",
  );

  const { tools } = setup({
    MCP_ADMIN_BLOG_URL: "https://admin.aquakart.co.in/blogs/{id}",
  });
  const created = await tools.createBlog(
    draftArgs({ titleImageAlt: "  Softener beside a geyser  " }),
    WRITE,
  );
  assert.equal(
    created.blog.adminUrl,
    `https://admin.aquakart.co.in/blogs/${created.blog.blogId}`,
  );
  const read = await tools.getBlog({ blogId: created.blog.blogId }, WRITE);
  assert.equal(read.blog.titleImageAlt, "Softener beside a geyser");
});
