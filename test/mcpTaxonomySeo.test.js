import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBlogTools } from "../src/services/mcp/blogTools.js";
import { createTaxonomySeoTools } from "../src/services/mcp/taxonomySeoTools.js";
import { createAquakartMcpServer } from "../src/services/mcp/server.js";
import { renderConsentPage } from "../src/services/mcp/consentPage.js";
import { permittedScopes } from "../src/services/mcp/oauthProvider.js";
import { MCP_SCOPES, MCP_SCOPE_LIST } from "../src/services/mcp/config.js";
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

// Category, subcategory and page-SEO MCP tools against in-memory fakes:
// no MongoDB, Cloudinary or network.

const WRITE = ctxFor([
  MCP_SCOPES.categoriesRead,
  MCP_SCOPES.categoriesWrite,
  MCP_SCOPES.seoRead,
  MCP_SCOPES.seoWrite,
  MCP_SCOPES.upload,
]);

const addTaxonomySeo = (store, clock) => {
  const categories = [];
  const subs = [];
  const seo = [];
  const productRefs = []; // { category, subCategory }
  const stamp = () => {
    clock.advance(1);
    return clock.now();
  };
  const byTitle = (list, title) =>
    clone(
      list.find((item) => item.title.toLowerCase() === title.toLowerCase()),
    ) || null;
  const update = (list, id, condition, set) => {
    const doc = list.find((item) => item._id === id);
    if (!doc) return null;
    const current = doc.updatedAt ? new Date(doc.updatedAt).getTime() : null;
    const expected = condition.updatedAt
      ? new Date(condition.updatedAt).getTime()
      : null;
    if (current !== expected) return null;
    Object.assign(doc, clone(set), { updatedAt: stamp() });
    return clone(doc);
  };
  const withParent = (sub) =>
    sub && {
      ...sub,
      category: (() => {
        const parent = categories.find((c) => c._id === sub.category);
        return parent ? { _id: parent._id, title: parent.title } : sub.category;
      })(),
    };
  Object.assign(store, {
    categoryDocs: categories,
    subDocs: subs,
    seoDocs: seo,
    productRefs,
    listCategories: async () => clone(categories),
    findCategory: async (id) =>
      clone(categories.find((c) => c._id === id)) || null,
    findCategoryByTitle: async (title) => byTitle(categories, title),
    createCategory: async (doc) => {
      const saved = {
        _id: objectId(),
        ...clone(doc),
        createdAt: stamp(),
        updatedAt: clock.now(),
      };
      categories.push(saved);
      return clone(saved);
    },
    updateCategory: async (id, condition, set) =>
      update(categories, id, condition, set),
    deleteCategory: async (id) => {
      categories.splice(
        categories.findIndex((c) => c._id === id),
        1,
      );
    },
    taxonomyCounts: async () => {
      const count = (rows, key) =>
        rows.reduce((acc, row) => {
          if (row[key]) acc[row[key]] = (acc[row[key]] || 0) + 1;
          return acc;
        }, {});
      return {
        subCategories: count(subs, "category"),
        categoryProducts: count(productRefs, "category"),
        subCategoryProducts: count(productRefs, "subCategory"),
      };
    },
    listSubCategories: async ({ category }) =>
      clone(subs.filter((s) => !category || s.category === category)).map(
        withParent,
      ),
    findSubCategory: async (id) =>
      withParent(clone(subs.find((s) => s._id === id))) || null,
    findSubCategoryByTitle: async (title) => byTitle(subs, title),
    createSubCategory: async (doc) => {
      const saved = {
        _id: objectId(),
        ...clone(doc),
        createdAt: stamp(),
        updatedAt: clock.now(),
      };
      subs.push(saved);
      return withParent(clone(saved));
    },
    updateSubCategory: async (id, condition, set) =>
      withParent(update(subs, id, condition, set)),
    deleteSubCategory: async (id) => {
      subs.splice(
        subs.findIndex((s) => s._id === id),
        1,
      );
    },
    productsInSubCategory: async (id) =>
      productRefs.filter((p) => p.subCategory === id).length,
    listSeo: async ({ active, skip, limit }) => {
      const items = seo.filter(
        (s) => active === undefined || s.active === active,
      );
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
    findSeo: async ({ seoId, pageKey }) =>
      clone(
        seo.find((s) => (seoId ? s._id === seoId : s.pageKey === pageKey)),
      ) || null,
    createSeo: async (doc) => {
      const saved = {
        _id: objectId(),
        active: true,
        robots: "index,follow",
        ...clone(doc),
        createdAt: stamp(),
        updatedAt: clock.now(),
      };
      seo.push(saved);
      return clone(saved);
    },
    updateSeo: async (id, condition, set) => update(seo, id, condition, set),
    seoReadiness: async ({ status }) => ({
      generatedAt: "2026-11-06T03:00:00.000Z",
      summary: { totalPages: 2, ready: 1, needsSeo: 1, overallScore: 60 },
      nextBestAction: {
        pageKey: "category.softeners",
        route: "/category/softeners",
        priority: "P0",
        score: 20,
        reason: "No SEO configuration exists for this pageKey",
        adminLinks: { seo: "https://crm/x" },
      },
      items: [
        {
          pageKey: "category.softeners",
          entityType: "category",
          entityId: "64b0000000000000000000c1",
          title: "Softeners",
          route: "/category/softeners",
          canonicalUrl: "https://aquakart.co.in/category/softeners",
          status: "NEEDS_SEO",
          priority: "P0",
          score: 20,
          missing: ["seo.record"],
          issues: [
            {
              code: "MISSING_SEO_RECORD",
              severity: "critical",
              field: "seo",
              message: "No SEO configuration exists for this pageKey",
              action: "CREATE_SEO",
            },
          ],
          recommendedActions: [
            {
              action: "CREATE_SEO",
              field: "seo",
              reason: "No SEO configuration",
            },
          ],
          adminLinks: { seo: "https://crm/x" },
          lastSeoUpdateAt: null,
        },
      ].filter((item) => !status || item.status === status),
    }),
  });
  return store;
};

const setup = () => {
  const clock = createClock();
  const store = addTaxonomySeo(createMemoryStore(clock), clock);
  const uploader = createFakeUploader();
  const audits = [];
  const runOperation = runnerFor(store, clock);
  const audit = async (entry) => audits.push(entry);
  const tools = createTaxonomySeoTools({ store, runOperation, audit });
  const blogs = createBlogTools({
    store,
    uploader,
    runOperation,
    config: testConfig(),
    now: clock.now,
    audit,
  });
  return { clock, store, uploader, audits, tools, blogs };
};

const upload = async (blogs, seed) =>
  (
    await blogs.uploadImage(
      { idempotencyKey: `upload-${seed}-0001`, imageBase64: pngBase64(seed) },
      WRITE,
    )
  ).media.mediaId;

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return "NO_ERROR";
};

test("categories: create with images, unique titles, idempotent replays", async () => {
  const { store, tools, blogs, audits } = setup();
  const mediaId = await upload(blogs, "cat");
  const created = await tools.createCategory(
    {
      idempotencyKey: "cat-softeners-01",
      title: "Water <b>Softeners</b>",
      description: "<p>Hard water fixes</p>",
      keywords: ["softener", "hard water", "softener"],
      mediaIds: [mediaId],
    },
    WRITE,
  );
  assert.equal(created.category.title, "Water Softeners");
  assert.equal(created.category.description, "Hard water fixes");
  assert.equal(created.category.keywords, "softener, hard water");
  assert.match(created.category.photos[0].id, /^Blogs\/mcp_/);
  assert.equal(audits.at(-1).action, "mcp.category.create");

  const replay = await tools.createCategory(
    {
      idempotencyKey: "cat-softeners-01",
      title: "Water <b>Softeners</b>",
      description: "<p>Hard water fixes</p>",
      keywords: ["softener", "hard water", "softener"],
      mediaIds: [mediaId],
    },
    WRITE,
  );
  assert.equal(replay.replayed, true);
  assert.equal(store.categoryDocs.length, 1);

  assert.equal(
    await codeOf(
      tools.createCategory(
        {
          idempotencyKey: "cat-softeners-02",
          title: "water softeners",
          mediaIds: [mediaId],
        },
        WRITE,
      ),
    ),
    "DUPLICATE_TITLE",
  );
  assert.equal(
    await codeOf(
      tools.createCategory(
        {
          idempotencyKey: "cat-other-0001",
          title: "Purifiers",
          mediaIds: [objectId()],
        },
        WRITE,
      ),
    ),
    "MEDIA_NOT_FOUND",
  );
});

test("categories: update checks revision, warns on rename, never deletes old photos", async () => {
  const { tools, blogs, uploader } = setup();
  const first = await upload(blogs, "one");
  const second = await upload(blogs, "two");
  const { category } = await tools.createCategory(
    {
      idempotencyKey: "cat-create-0001",
      title: "Purifiers",
      mediaIds: [first],
    },
    WRITE,
  );
  const updated = await tools.updateCategory(
    {
      idempotencyKey: "cat-update-0001",
      categoryId: category.categoryId,
      expectedRevision: category.revision,
      title: "RO Purifiers",
      mediaIds: [second],
    },
    WRITE,
  );
  assert.equal(updated.category.title, "RO Purifiers");
  assert.deepEqual(updated.warnings, [
    "TITLE_CHANGED_STOREFRONT_URL",
    "OLD_PHOTOS_KEPT_IN_CLOUDINARY",
  ]);
  assert.deepEqual(uploader.destroyed, []);
  assert.equal(
    await codeOf(
      tools.updateCategory(
        {
          idempotencyKey: "cat-update-0002",
          categoryId: category.categoryId,
          expectedRevision: category.revision,
          description: "stale",
        },
        WRITE,
      ),
    ),
    "REVISION_CONFLICT",
  );
  assert.equal(
    await codeOf(
      tools.updateCategory(
        {
          idempotencyKey: "cat-update-0003",
          categoryId: objectId(),
          title: "X",
        },
        WRITE,
      ),
    ),
    "CATEGORY_NOT_FOUND",
  );
});

test("deletes are refused while anything uses the category or subcategory", async () => {
  const { store, tools, blogs, audits } = setup();
  const mediaId = await upload(blogs, "del");
  const { category } = await tools.createCategory(
    {
      idempotencyKey: "cat-del-000001",
      title: "Softeners",
      mediaIds: [mediaId],
    },
    WRITE,
  );
  const { subCategory } = await tools.createSubCategory(
    {
      idempotencyKey: "sub-del-000001",
      category: category.categoryId,
      title: "Automatic Softeners",
    },
    WRITE,
  );
  assert.equal(subCategory.category.title, "Softeners");

  const listed = await tools.listCategories({});
  assert.equal(listed.categories[0].subCategoryCount, 1);

  assert.equal(
    await codeOf(
      tools.deleteCategory(
        { idempotencyKey: "cat-del-try-01", categoryId: category.categoryId },
        WRITE,
      ),
    ),
    "CATEGORY_IN_USE",
  );
  store.productRefs.push({
    category: category.categoryId,
    subCategory: subCategory.subCategoryId,
  });
  assert.equal(
    await codeOf(
      tools.deleteSubCategory(
        {
          idempotencyKey: "sub-del-try-01",
          subCategoryId: subCategory.subCategoryId,
        },
        WRITE,
      ),
    ),
    "SUBCATEGORY_IN_USE",
  );

  store.productRefs.length = 0;
  const removedSub = await tools.deleteSubCategory(
    {
      idempotencyKey: "sub-del-ok-001",
      subCategoryId: subCategory.subCategoryId,
    },
    WRITE,
  );
  assert.equal(removedSub.deleted, true);
  const removed = await tools.deleteCategory(
    { idempotencyKey: "cat-del-ok-001", categoryId: category.categoryId },
    WRITE,
  );
  assert.equal(removed.deleted, true);
  assert.equal(store.categoryDocs.length, 0);
  assert.equal(audits.at(-1).action, "mcp.category.delete");
  // A new request for an already-deleted category reports it, not an error.
  const again = await tools.deleteCategory(
    { idempotencyKey: "cat-del-ok-002", categoryId: category.categoryId },
    WRITE,
  );
  assert.equal(again.alreadyDeleted, true);
});

test("subcategories need an existing parent and cannot move while products use them", async () => {
  const { store, tools, blogs } = setup();
  const mediaId = await upload(blogs, "sub");
  const a = await tools.createCategory(
    {
      idempotencyKey: "cat-a-0000001",
      title: "Softeners",
      mediaIds: [mediaId],
    },
    WRITE,
  );
  const b = await tools.createCategory(
    {
      idempotencyKey: "cat-b-0000001",
      title: "Purifiers",
      mediaIds: [mediaId],
    },
    WRITE,
  );
  assert.equal(
    await codeOf(
      tools.createSubCategory(
        {
          idempotencyKey: "sub-bad-000001",
          category: objectId(),
          title: "Orphan",
        },
        WRITE,
      ),
    ),
    "INVALID_REFERENCE",
  );
  const { subCategory } = await tools.createSubCategory(
    {
      idempotencyKey: "sub-ok-0000001",
      category: a.category.categoryId,
      title: "Manual",
    },
    WRITE,
  );
  store.productRefs.push({
    category: a.category.categoryId,
    subCategory: subCategory.subCategoryId,
  });
  assert.equal(
    await codeOf(
      tools.updateSubCategory(
        {
          idempotencyKey: "sub-move-00001",
          subCategoryId: subCategory.subCategoryId,
          category: b.category.categoryId,
        },
        WRITE,
      ),
    ),
    "SUBCATEGORY_IN_USE",
  );
  const renamed = await tools.updateSubCategory(
    {
      idempotencyKey: "sub-rename-001",
      subCategoryId: subCategory.subCategoryId,
      title: "Manual Softeners",
    },
    WRITE,
  );
  assert.equal(renamed.subCategory.title, "Manual Softeners");
  assert.deepEqual(renamed.warnings, ["TITLE_CHANGED_STOREFRONT_URL"]);
  const got = await tools.getCategory({ categoryId: a.category.categoryId });
  assert.equal(got.subCategories[0].productCount, 1);
});

test("SEO: create validates with the CRM rules, keys are unique, updates are partial", async () => {
  const { store, tools, audits } = setup();
  const created = await tools.createSeo(
    {
      idempotencyKey: "seo-home-00001",
      pageKey: "Category.Softeners",
      route: "/category/softeners",
      title: "Water Softeners in Hyderabad | Aquakart",
      description: "Automatic and manual water softeners with installation.",
      keywords: ["water softener", "water softener"],
      canonicalUrl: "https://aquakart.co.in/category/softeners",
    },
    WRITE,
  );
  assert.equal(created.seo.pageKey, "category.softeners");
  assert.deepEqual(created.seo.keywords, ["water softener"]);
  assert.equal(store.seoDocs[0].createdBy, WRITE.auth.adminUserId);
  assert.equal(audits.at(-1).action, "mcp.seo.create");

  for (const [overrides, code] of [
    [{ route: "category/x" }, "VALIDATION_FAILED"],
    [{ canonicalUrl: "not a url" }, "VALIDATION_FAILED"],
    [{ pageKey: "category.softeners" }, "PAGE_KEY_TAKEN"],
  ]) {
    assert.equal(
      await codeOf(
        tools.createSeo(
          {
            idempotencyKey: `seo-bad-${code.length}${Object.keys(overrides)[0]}`,
            pageKey: "page.other",
            route: "/other",
            title: "Other",
            ...overrides,
          },
          WRITE,
        ),
      ),
      code,
      JSON.stringify(overrides),
    );
  }

  const off = await tools.updateSeo(
    {
      idempotencyKey: "seo-off-000001",
      seoId: created.seo.seoId,
      expectedRevision: created.seo.revision,
      active: false,
      ogTitle: "Softeners",
    },
    WRITE,
  );
  assert.equal(off.seo.active, false);
  assert.equal(off.seo.ogTitle, "Softeners");
  assert.equal(off.seo.title, "Water Softeners in Hyderabad | Aquakart");
  assert.equal(
    await codeOf(
      tools.updateSeo(
        {
          idempotencyKey: "seo-stale-0001",
          seoId: created.seo.seoId,
          expectedRevision: created.seo.revision,
          title: "Stale",
        },
        WRITE,
      ),
    ),
    "REVISION_CONFLICT",
  );
  const listed = await tools.listSeo({ active: false });
  assert.equal(listed.total, 1);
  assert.equal(
    (await tools.getSeo({ pageKey: "CATEGORY.SOFTENERS" })).seo.seoId,
    created.seo.seoId,
  );
});

test("SEO readiness lists every page's status, issues and next action", async () => {
  const { tools } = setup();
  const report = await tools.getSeoReadiness({ status: "NEEDS_SEO" });
  assert.equal(report.summary.totalPages, 2);
  assert.equal(report.nextBestAction.pageKey, "category.softeners");
  assert.ok(!("adminLinks" in report.nextBestAction));
  assert.deepEqual(report.pages[0].issues[0], {
    code: "MISSING_SEO_RECORD",
    severity: "critical",
    field: "seo",
    message: "No SEO configuration exists for this pageKey",
  });
});

test("taxonomy/SEO tools over MCP: registered, scoped, and write scopes start unticked", async () => {
  const { tools, blogs } = setup();
  const call = async (scopes, name, args) => {
    const server = createAquakartMcpServer({
      blogTools: blogs,
      instagramTools: {},
      taxonomySeoTools: tools,
      auth: ctxFor(scopes).auth,
      correlationId: "test-correlation-id",
      resourceMetadataUrl: "http://localhost/.well-known/x",
      log: { log() {}, error() {} },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    return { names, result };
  };
  const { names, result } = await call(
    [MCP_SCOPES.seoRead],
    "aquakart_get_seo_readiness",
    { limit: 10 },
  );
  for (const name of [
    "aquakart_list_categories",
    "aquakart_get_category",
    "aquakart_create_category",
    "aquakart_update_category",
    "aquakart_delete_category",
    "aquakart_list_subcategories",
    "aquakart_get_subcategory",
    "aquakart_create_subcategory",
    "aquakart_update_subcategory",
    "aquakart_delete_subcategory",
    "aquakart_list_seo",
    "aquakart_get_seo",
    "aquakart_get_seo_readiness",
    "aquakart_create_seo",
    "aquakart_update_seo",
  ])
    assert.ok(names.includes(name), name);
  assert.equal(result.structuredContent.ok, true);

  const refused = (
    await call([MCP_SCOPES.categoriesRead], "aquakart_delete_category", {
      idempotencyKey: "cat-del-scope1",
      categoryId: objectId(),
    })
  ).result;
  assert.equal(
    JSON.parse(refused.content[0].text).error.code,
    "INSUFFICIENT_SCOPE",
  );

  const page = renderConsentPage({
    action: "/consent",
    requestId: "r",
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scopes: MCP_SCOPE_LIST,
  });
  assert.match(page, /value="categories:write">/);
  assert.match(page, /value="seo:write">/);
  assert.match(page, /value="seo:read" checked>/);

  const seoEditor = {
    role: 0,
    roleRef: {
      slug: "seo",
      isActive: true,
      permissions: ["seo.read", "seo.manage"],
    },
  };
  assert.deepEqual(
    permittedScopes(seoEditor, ["seo:read", "seo:write", "categories:write"]),
    ["seo:read", "seo:write"],
  );
});
