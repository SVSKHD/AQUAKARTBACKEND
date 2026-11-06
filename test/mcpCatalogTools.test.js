import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBlogTools } from "../src/services/mcp/blogTools.js";
import { createCatalogTools } from "../src/services/mcp/catalogTools.js";
import { createAquakartMcpServer } from "../src/services/mcp/server.js";
import {
  consentSecurityHeaders,
  renderConsentPage,
} from "../src/services/mcp/consentPage.js";
import { permittedScopes } from "../src/services/mcp/oauthProvider.js";
import {
  MCP_SCOPES,
  MCP_SCOPE_LIST,
  SCOPE_PERMISSIONS,
} from "../src/services/mcp/config.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import {
  clone,
  createClock,
  createFakeUploader,
  createMemoryStore,
  ctxFor,
  objectId,
  pngBase64,
  runnerFor,
  testConfig,
} from "./support/mcpFakes.js";

// Product/coupon MCP tools against in-memory fakes: no MongoDB, Cloudinary
// or network. Covers field allowlists (no dealer price / customer ids),
// validation, duplicate protection, idempotent replays and crash recovery.

const PRODUCTS = ctxFor([
  MCP_SCOPES.productsRead,
  MCP_SCOPES.productsWrite,
  MCP_SCOPES.upload,
  MCP_SCOPES.write,
]);
const COUPONS = ctxFor([MCP_SCOPES.couponsRead, MCP_SCOPES.couponsWrite]);

const addCatalog = (store) => {
  const productDocs = [];
  const couponDocs = [];
  const categoryIds = new Set();
  const duplicateKey = () =>
    Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  const blogsUsingImage = store.blogsUsingImage;
  Object.assign(store, {
    productDocs,
    couponDocs,
    categoryIds,
    listProducts: async ({ query, skip, limit }) => {
      const items = productDocs.filter(
        (p) => !query || p.title.toLowerCase().includes(query.toLowerCase()),
      );
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
    findProduct: async (id) =>
      clone(productDocs.find((p) => p._id === id)) || null,
    findProductByTitle: async (title) =>
      clone(
        productDocs.find((p) => p.title.toLowerCase() === title.toLowerCase()),
      ) || null,
    productSkuTaken: async (sku) =>
      productDocs.some((p) => p.sku?.toLowerCase() === sku.toLowerCase()),
    createProduct: async (doc) => {
      store.calls.createProduct = (store.calls.createProduct || 0) + 1;
      const saved = { _id: objectId(), ...clone(doc) };
      productDocs.push(saved);
      store.products.add(saved._id);
      return clone(saved);
    },
    productExists: async (id) =>
      store.products.has(id) || productDocs.some((p) => p._id === id),
    categoryExists: async (id) => categoryIds.has(id),
    blogsUsingImage: async (publicId, excludeBlogId) =>
      (await blogsUsingImage(publicId, excludeBlogId)) ||
      productDocs.some((p) =>
        (p.photos || []).some((ph) => ph.id === publicId),
      ),
    listCoupons: async ({ status, skip, limit }) => {
      const items = couponDocs.filter((c) => !status || c.status === status);
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
    findCoupon: async ({ couponId, code }) =>
      clone(
        couponDocs.find((c) =>
          couponId ? c._id === couponId : c.code === code,
        ),
      ) || null,
    createCoupon: async (doc) => {
      if (couponDocs.some((c) => c.code === doc.code)) throw duplicateKey();
      const saved = { _id: objectId(), usageCount: 0, ...clone(doc) };
      couponDocs.push(saved);
      return clone(saved);
    },
  });
  return store;
};

const setup = () => {
  const clock = createClock();
  const store = addCatalog(createMemoryStore(clock));
  const uploader = createFakeUploader();
  const audits = [];
  const runOperation = runnerFor(store, clock);
  const audit = async (entry) => audits.push(entry);
  const config = testConfig();
  const catalog = createCatalogTools({
    store,
    runOperation,
    now: clock.now,
    audit,
  });
  const blogs = createBlogTools({
    store,
    uploader,
    runOperation,
    config,
    now: clock.now,
    audit,
  });
  return { clock, store, uploader, audits, catalog, blogs };
};

const uploadMedia = async (blogs, seed = "a") =>
  (
    await blogs.uploadImage(
      { idempotencyKey: `upload-${seed}-0001`, imageBase64: pngBase64(seed) },
      PRODUCTS,
    )
  ).media.mediaId;

const productArgs = (mediaIds, overrides = {}) => ({
  idempotencyKey: "product-softener-0001",
  title: "Aquakart Auto Water Softener 25L",
  description: '<p>Removes hardness.</p><script>alert("x")</script>',
  price: 24999,
  discountPrice: 19999,
  stock: 12,
  brand: "Aquakart",
  mediaIds,
  sku: "AQ-SOFT-25",
  keywords: ["softener", "hard water", "softener"],
  ...overrides,
});

const couponArgs = (overrides = {}) => ({
  idempotencyKey: "coupon-diwali-0001",
  code: "diwali10",
  discountType: "percentage",
  discountValue: 10,
  maxDiscount: 2000,
  endsAt: "2026-12-31T23:59:59+05:30",
  ...overrides,
});

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return "NO_ERROR";
};

test("product reads never return dealer price, reviews or reviewer ids", async () => {
  const { store, catalog } = setup();
  store.productDocs.push({
    _id: objectId(),
    title: "RO Purifier",
    brand: "Aquakart",
    price: 15000,
    dpPrice: 9000,
    stock: 3,
    description: "<p>Pure water</p>",
    reviews: [{ user: objectId(), name: "A customer", rating: 5 }],
    user: objectId(),
    photos: [{ id: "products/ro", secure_url: "https://x/ro.png" }],
  });
  const list = await catalog.listProducts({});
  const one = await catalog.getProduct({
    productId: list.products[0].productId,
  });
  for (const view of [list.products[0], one.product]) {
    const json = JSON.stringify(view);
    assert.ok(!json.includes("dpPrice") && !json.includes("9000"));
    assert.ok(!json.includes("A customer") && !("reviews" in view));
    assert.ok(!("user" in view));
  }
  assert.equal(one.product.imageUrl, "https://x/ro.png");
  assert.equal(
    await codeOf(catalog.getProduct({ productId: objectId() })),
    "PRODUCT_NOT_FOUND",
  );
});

test("create product uses uploaded media, sanitizes and stays out of the merchant feed", async () => {
  const { store, catalog, blogs, audits } = setup();
  const mediaId = await uploadMedia(blogs);
  const created = await catalog.createProduct(productArgs([mediaId]), PRODUCTS);
  assert.equal(created.replayed, false);
  const saved = store.productDocs[0];
  assert.equal(saved.merchantEnabled, false);
  assert.equal(saved.discountPriceStatus, true);
  assert.equal(saved.discountPricePercentage, 20);
  assert.ok(!saved.description.includes("script"));
  assert.equal(saved.keywords, "softener, hard water");
  assert.equal(saved.photos.length, 1);
  assert.match(saved.photos[0].id, /^Blogs\/mcp_[a-f0-9]{32}$/);
  assert.equal(saved.user, PRODUCTS.auth.adminUserId);
  assert.equal(created.product.discountPrice, 19999);
  assert.equal(audits.at(-1).action, "mcp.product.create");

  // Same key again: replayed, no second product.
  const again = await catalog.createProduct(productArgs([mediaId]), PRODUCTS);
  assert.equal(again.replayed, true);
  assert.equal(store.productDocs.length, 1);

  // Different key, same title or SKU: refused.
  assert.equal(
    await codeOf(
      catalog.createProduct(
        productArgs([mediaId], { idempotencyKey: "product-softener-0002" }),
        PRODUCTS,
      ),
    ),
    "DUPLICATE_TITLE",
  );
  assert.equal(
    await codeOf(
      catalog.createProduct(
        productArgs([mediaId], {
          idempotencyKey: "product-softener-0003",
          title: "Another Softener",
        }),
        PRODUCTS,
      ),
    ),
    "DUPLICATE_SKU",
  );
});

test("create product validates input, images and references", async () => {
  const { store, catalog, blogs } = setup();
  const mediaId = await uploadMedia(blogs);
  const tries = [
    [{ discountPrice: 30000 }, "VALIDATION_FAILED"],
    [{ subCategory: objectId() }, "VALIDATION_FAILED"],
    [{ description: "<script>x</script>" }, "VALIDATION_FAILED"],
    [{ mediaIds: [objectId()] }, "MEDIA_NOT_FOUND"],
    [{ category: objectId() }, "INVALID_REFERENCE"],
  ];
  for (const [index, [overrides, code]] of tries.entries()) {
    assert.equal(
      await codeOf(
        catalog.createProduct(
          productArgs([mediaId], {
            idempotencyKey: `product-bad-000${index}`,
            ...overrides,
          }),
          PRODUCTS,
        ),
      ),
      code,
      JSON.stringify(overrides),
    );
  }
  assert.equal(store.productDocs.length, 0);
});

test("a retry after a crash returns the product the first attempt saved", async () => {
  const { store, catalog, blogs } = setup();
  const mediaId = await uploadMedia(blogs);
  const realFinish = store.finishOperation;
  store.finishOperation = async () => {
    throw new Error("process died before recording the result");
  };
  await assert.rejects(catalog.createProduct(productArgs([mediaId]), PRODUCTS));
  store.finishOperation = realFinish;
  // Lock lease expired: the same request is retried.
  for (const op of store.operations) op.lockedUntil = new Date(0);
  const retried = await catalog.createProduct(productArgs([mediaId]), PRODUCTS);
  assert.equal(store.productDocs.length, 1);
  assert.equal(store.calls.createProduct, 1);
  assert.equal(retried.product.productId, store.productDocs[0]._id);
});

test("replacing a blog title image never deletes a photo a product uses", async () => {
  const { store, catalog, blogs, uploader } = setup();
  const shared = await uploadMedia(blogs, "shared");
  const other = await uploadMedia(blogs, "other");
  await catalog.createProduct(productArgs([shared]), PRODUCTS);
  const draft = await blogs.createBlog(
    {
      idempotencyKey: "blog-share-0001",
      title: "Softener buying guide for apartments",
      description: "<p>Hard water guide for apartments in Hyderabad.</p>",
    },
    PRODUCTS,
  );
  const blogId = draft.blog.blogId;
  await blogs.attachImage(
    { idempotencyKey: "attach-shared-01", blogId, mediaId: shared },
    PRODUCTS,
  );
  await blogs.attachImage(
    { idempotencyKey: "attach-other-001", blogId, mediaId: other },
    PRODUCTS,
  );
  const sharedPublicId = store.media.find((m) => m._id === shared).publicId;
  assert.ok(!uploader.destroyed.includes(sharedPublicId));
});

test("coupons are drafts by default, uppercase, validated and never duplicated", async () => {
  const { store, catalog, audits } = setup();
  const created = await catalog.createCoupon(couponArgs(), COUPONS);
  assert.equal(created.coupon.code, "DIWALI10");
  assert.equal(created.coupon.status, "draft");
  assert.equal(store.couponDocs[0].createdBy, COUPONS.auth.adminUserId);
  assert.equal(audits.at(-1).action, "mcp.coupon.create");

  const replay = await catalog.createCoupon(couponArgs(), COUPONS);
  assert.equal(replay.replayed, true);
  assert.equal(store.couponDocs.length, 1);

  const bad = [
    [{ code: "DIWALI10" }, "COUPON_CODE_TAKEN"],
    [{ code: "x!" }, "VALIDATION_FAILED"],
    [{ discountValue: 150 }, "VALIDATION_FAILED"],
    [{ endsAt: "2026-01-01T00:00:00Z" }, "VALIDATION_FAILED"],
    [
      {
        startsAt: "2026-12-31T00:00:00Z",
        endsAt: "2026-12-01T00:00:00Z",
      },
      "VALIDATION_FAILED",
    ],
    [{ productIds: [objectId()] }, "INVALID_REFERENCE"],
    [{ categoryIds: [objectId()] }, "INVALID_REFERENCE"],
  ];
  for (const [index, [overrides, code]] of bad.entries()) {
    assert.equal(
      await codeOf(
        catalog.createCoupon(
          couponArgs({
            idempotencyKey: `coupon-bad-000${index}`,
            code: `BAD${index}X`,
            ...overrides,
          }),
          COUPONS,
        ),
      ),
      code,
      JSON.stringify(overrides),
    );
  }

  const active = await catalog.createCoupon(
    couponArgs({
      idempotencyKey: "coupon-flat-0001",
      code: "FLAT500",
      discountType: "fixed",
      discountValue: 500,
      status: "active",
    }),
    COUPONS,
  );
  assert.equal(active.coupon.status, "active");
});

test("coupon reads count targeted customers but never return their ids", async () => {
  const { store, catalog } = setup();
  const customer = objectId();
  store.couponDocs.push({
    _id: objectId(),
    code: "VIP1",
    status: "active",
    discountType: "fixed",
    discountValue: 100,
    endsAt: new Date("2026-12-31"),
    userIds: [customer],
  });
  const list = await catalog.listCoupons({});
  const one = await catalog.getCoupon({ code: "vip1" });
  for (const view of [list.coupons[0], one.coupon]) {
    assert.equal(view.targetedAccounts, 1);
    assert.ok(!JSON.stringify(view).includes(customer));
  }
});

test("catalog tools enforce their scopes over MCP; write scopes start unticked", async () => {
  const { catalog, blogs } = setup();
  const callTool = async (scopes, name, args) => {
    const server = createAquakartMcpServer({
      blogTools: blogs,
      instagramTools: {},
      catalogTools: catalog,
      auth: ctxFor(scopes).auth,
      correlationId: "test-correlation-id",
      resourceMetadataUrl: "http://localhost/.well-known/x",
      log: { log() {}, error() {} },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    const listed = await client.listTools();
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    return { result, names: listed.tools.map((tool) => tool.name) };
  };

  const { result: refused, names } = await callTool(
    [MCP_SCOPES.couponsRead],
    "aquakart_create_coupon",
    couponArgs(),
  );
  // The SDK client accepted the error result (no schema mismatch) and the
  // error code travels in the text content.
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent, undefined);
  assert.equal(
    JSON.parse(refused.content[0].text).error.code,
    "INSUFFICIENT_SCOPE",
  );
  for (const name of [
    "aquakart_list_products",
    "aquakart_get_product",
    "aquakart_create_product",
    "aquakart_list_coupons",
    "aquakart_get_coupon",
    "aquakart_create_coupon",
  ])
    assert.ok(names.includes(name), name);

  const { result: listed } = await callTool(
    [MCP_SCOPES.couponsRead],
    "aquakart_list_coupons",
    {},
  );
  assert.equal(listed.structuredContent.ok, true);

  // Write scopes need a deliberate tick on the consent page.
  const page = renderConsentPage({
    action: "/consent",
    requestId: "r",
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scopes: MCP_SCOPE_LIST,
  });
  for (const scope of ["products:write", "coupons:write"])
    assert.match(page, new RegExp(`value="${scope}">`));
  assert.match(page, /value="products:read" checked>/);
});

test("product scopes need the new admin-only permissions; coupons reuse coupon permissions", () => {
  assert.ok(PERMISSIONS.includes("products.read"));
  assert.ok(PERMISSIONS.includes("products.manage"));
  assert.equal(SCOPE_PERMISSIONS["products:write"], "products.manage");
  assert.equal(SCOPE_PERMISSIONS["coupons:write"], "coupons.manage");
  const blogEditor = {
    role: 0,
    roleRef: { slug: "editor", isActive: true, permissions: ["blogs.manage"] },
  };
  assert.deepEqual(
    permittedScopes(blogEditor, [
      "blogs:write",
      "products:write",
      "coupons:read",
    ]),
    ["blogs:write"],
  );
  const admin = { role: 1 };
  assert.deepEqual(
    permittedScopes(admin, ["products:write", "coupons:write"]),
    ["products:write", "coupons:write"],
  );
});

test("consent page shows the logo (white in dark mode) and its CSP allows only that host", async () => {
  const config = testConfig();
  const logo = {
    light: config.brand.badgeUrl,
    dark: config.brand.badgeWhiteUrl,
  };
  const page = renderConsentPage({
    action: "/consent",
    requestId: "r",
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scopes: MCP_SCOPE_LIST,
    logo,
  });
  assert.match(
    page,
    /<source srcset="[^"]*logo-white_rpvptt\.png" media="\(prefers-color-scheme: dark\)">/,
  );
  assert.match(page, /<img src="[^"]*logo_nt2v92\.png" alt="Aquakart"/);
  const headers = {};
  consentSecurityHeaders(
    { set: (values) => Object.assign(headers, values) },
    "https://claude.ai/api/mcp/auth_callback",
    logo,
  );
  assert.match(
    headers["Content-Security-Policy"],
    /default-src 'none'; style-src 'unsafe-inline'; img-src https:\/\/res\.cloudinary\.com; form-action 'self' https:\/\/claude\.ai;/,
  );
});

test("brand assets are available to any signed-in connection over MCP", async () => {
  const { catalog, blogs } = setup();
  const server = createAquakartMcpServer({
    blogTools: blogs,
    instagramTools: {},
    catalogTools: catalog,
    auth: ctxFor([]).auth,
    correlationId: "test-correlation-id",
    resourceMetadataUrl: "http://localhost/.well-known/x",
    log: { log() {}, error() {} },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientSide);
  assert.match(client.getInstructions(), /aquakart_get_brand_assets/);
  const result = await client.callTool({
    name: "aquakart_get_brand_assets",
    arguments: {},
  });
  await client.close();
  assert.equal(result.isError, undefined);
  const { brand } = result.structuredContent;
  assert.deepEqual(
    brand.logos.map((item) => item.variant),
    ["original", "white"],
  );
});
