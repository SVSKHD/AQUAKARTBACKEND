import * as z from "zod";
import { MCP_SCOPES } from "./config.js";
import { IDEMPOTENCY_KEY, OBJECT_ID } from "../../validators/mcp/blog.js";

// MCP tool definitions for categories, subcategories and page SEO. The
// `register` helper from server.js adds scope checks, envelopes and logs.

const objectId = z.string().regex(OBJECT_ID, "must be a 24-character id");
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
    "Revision from your last read; fails with REVISION_CONFLICT if it changed since.",
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
  openWorldHint: true,
  idempotentHint: true,
};
const DELETE = { ...WRITE, destructiveHint: true };

const photo = z.object({ id: z.string(), secure_url: z.string() });
const keywords = z
  .union([z.string().max(1000), z.array(z.string().max(80)).max(30)])
  .describe("Comma-separated string or list");
const mediaIds = (min) =>
  z
    .array(objectId)
    .min(min)
    .max(5)
    .describe(
      "mediaIds from aquakart_upload_image; replaces the current photos (old files are kept in Cloudinary)",
    );

const category = z.object({
  categoryId: z.string(),
  title: z.string(),
  description: z.string(),
  keywords: z.string(),
  photos: z.array(photo),
  subCategoryCount: z.number().nullable(),
  productCount: z.number().nullable(),
  revision: z.string(),
  createdAt: z.string().nullable(),
});
const subCategory = z.object({
  subCategoryId: z.string(),
  title: z.string(),
  description: z.string(),
  keywords: z.string(),
  photos: z.array(photo),
  category: z.object({ id: z.string(), title: z.string() }).nullable(),
  productCount: z.number().nullable(),
  revision: z.string(),
  createdAt: z.string().nullable(),
});
const deleted = (idField) => ({
  deleted: z.boolean(),
  alreadyDeleted: z.boolean(),
  [idField]: z.string(),
});

const seoFields = {
  route: z.string().min(1).max(500).describe("Storefront path, starts with /"),
  title: z
    .string()
    .min(1)
    .max(120)
    .describe("Meta title (ideally 50-60 chars)"),
  description: z
    .string()
    .max(500)
    .describe("Meta description (ideally 140-160 chars)"),
  keywords: z.array(z.string().max(100)).max(50),
  canonicalUrl: z.string().max(1000).describe("Absolute http(s) URL or empty"),
  robots: z.string().max(100).describe("e.g. index,follow or noindex,nofollow"),
  ogTitle: z.string().max(120),
  ogDescription: z.string().max(500),
  ogImage: z.string().max(1000).describe("Absolute http(s) image URL or empty"),
  twitterTitle: z.string().max(120),
  twitterDescription: z.string().max(500),
  twitterImage: z.string().max(1000),
  schemaJson: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("JSON-LD object, or null to clear"),
  aiLocked: z
    .boolean()
    .describe("true keeps the weekly AI SEO refresh from changing this page"),
};
const PAGE_KEY = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i, "letters/digits joined by . _ -");
const optional = (shape) =>
  Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.optional()]),
  );
const seoPage = z.object({
  seoId: z.string(),
  pageKey: z.string(),
  route: z.string(),
  title: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  canonicalUrl: z.string(),
  robots: z.string(),
  ogTitle: z.string(),
  ogDescription: z.string(),
  ogImage: z.string(),
  twitterTitle: z.string(),
  twitterDescription: z.string(),
  twitterImage: z.string(),
  schemaJson: z.unknown(),
  active: z.boolean(),
  aiLocked: z.boolean(),
  aiRefreshedAt: z.string().nullable(),
  revision: z.string(),
  updatedAt: z.string().nullable(),
});
const readinessPage = z.object({
  pageKey: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  title: z.string(),
  route: z.string(),
  canonicalUrl: z.string(),
  status: z.string(),
  priority: z.string(),
  score: z.number().nullable(),
  missing: z.array(z.string()),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      field: z.string(),
      message: z.string(),
    }),
  ),
  recommendedActions: z.array(
    z.object({ action: z.string(), field: z.string(), reason: z.string() }),
  ),
  lastSeoUpdateAt: z.string().nullable(),
});

export const registerTaxonomySeoTools = (register, tools) => {
  // ---- Categories ----------------------------------------------------
  register(
    "aquakart_list_categories",
    {
      title: "List categories",
      description:
        "All product categories with photos, keywords and how many subcategories and products use each.",
      scopes: [MCP_SCOPES.categoriesRead],
      input: z.strictObject({
        query: z.string().max(100).optional().describe("Title search"),
      }),
      output: envelope({ categories: z.array(category), total: z.number() }),
      annotations: READ,
    },
    (args) => tools.listCategories(args),
  );
  register(
    "aquakart_get_category",
    {
      title: "Get category",
      description: "One category with its subcategories and product counts.",
      scopes: [MCP_SCOPES.categoriesRead],
      input: z.strictObject({ categoryId: objectId }),
      output: envelope({ category, subCategories: z.array(subCategory) }),
      annotations: READ,
    },
    (args) => tools.getCategory(args),
  );
  register(
    "aquakart_create_category",
    {
      title: "Create category",
      description:
        "Create a product category; it is live on the storefront immediately. Needs 1-5 images uploaded with aquakart_upload_image. Titles must be unique (the storefront looks categories up by title).",
      scopes: [MCP_SCOPES.categoriesWrite],
      input: z.strictObject({
        idempotencyKey,
        title: z.string().min(1).max(120),
        description: z.string().max(5000).optional().describe("Plain text"),
        keywords: keywords.optional(),
        mediaIds: mediaIds(1),
      }),
      output: envelope({ category }, true),
      annotations: WRITE,
    },
    (args, ctx) => tools.createCategory(args, ctx),
  );
  register(
    "aquakart_update_category",
    {
      title: "Update category",
      description:
        "Edit a category. Omitted fields stay unchanged. Renaming changes its storefront URL (warning TITLE_CHANGED_STOREFRONT_URL). mediaIds replaces the photos; old files are not deleted.",
      scopes: [MCP_SCOPES.categoriesWrite],
      input: z.strictObject({
        idempotencyKey,
        categoryId: objectId,
        expectedRevision,
        title: z.string().min(1).max(120).optional(),
        description: z.string().max(5000).optional(),
        keywords: keywords.optional(),
        mediaIds: mediaIds(1).optional(),
      }),
      output: envelope({ category, warnings: z.array(z.string()) }, true),
      annotations: WRITE,
    },
    (args, ctx) => tools.updateCategory(args, ctx),
  );
  register(
    "aquakart_delete_category",
    {
      title: "Delete category",
      description:
        "Permanently delete a category. Refused with CATEGORY_IN_USE while any subcategory or product uses it. Its photos stay in Cloudinary.",
      scopes: [MCP_SCOPES.categoriesWrite],
      input: z.strictObject({
        idempotencyKey,
        categoryId: objectId,
        expectedRevision,
      }),
      output: envelope(deleted("categoryId"), true),
      annotations: DELETE,
    },
    (args, ctx) => tools.deleteCategory(args, ctx),
  );

  // ---- Subcategories -------------------------------------------------
  register(
    "aquakart_list_subcategories",
    {
      title: "List subcategories",
      description:
        "Subcategories with their parent category and product counts; optionally only one category's.",
      scopes: [MCP_SCOPES.categoriesRead],
      input: z.strictObject({
        category: objectId.optional().describe("Parent category id"),
        query: z.string().max(100).optional().describe("Title search"),
      }),
      output: envelope({
        subCategories: z.array(subCategory),
        total: z.number(),
      }),
      annotations: READ,
    },
    (args) => tools.listSubCategories(args),
  );
  register(
    "aquakart_get_subcategory",
    {
      title: "Get subcategory",
      description: "One subcategory with its parent category.",
      scopes: [MCP_SCOPES.categoriesRead],
      input: z.strictObject({ subCategoryId: objectId }),
      output: envelope({ subCategory }),
      annotations: READ,
    },
    (args) => tools.getSubCategory(args),
  );
  register(
    "aquakart_create_subcategory",
    {
      title: "Create subcategory",
      description:
        "Create a subcategory under an existing category; live immediately. Images are optional (mediaIds from aquakart_upload_image). Titles must be unique.",
      scopes: [MCP_SCOPES.categoriesWrite],
      input: z.strictObject({
        idempotencyKey,
        category: objectId.describe("Parent category id"),
        title: z.string().min(1).max(120),
        description: z.string().max(5000).optional().describe("Plain text"),
        keywords: keywords.optional(),
        mediaIds: mediaIds(0).optional(),
      }),
      output: envelope({ subCategory }, true),
      annotations: WRITE,
    },
    (args, ctx) => tools.createSubCategory(args, ctx),
  );
  register(
    "aquakart_update_subcategory",
    {
      title: "Update subcategory",
      description:
        "Edit a subcategory. Omitted fields stay unchanged. Moving it to another category is refused while products use it. mediaIds replaces the photos; old files are not deleted.",
      scopes: [MCP_SCOPES.categoriesWrite],
      input: z.strictObject({
        idempotencyKey,
        subCategoryId: objectId,
        expectedRevision,
        category: objectId.optional(),
        title: z.string().min(1).max(120).optional(),
        description: z.string().max(5000).optional(),
        keywords: keywords.optional(),
        mediaIds: mediaIds(0).optional(),
      }),
      output: envelope({ subCategory, warnings: z.array(z.string()) }, true),
      annotations: WRITE,
    },
    (args, ctx) => tools.updateSubCategory(args, ctx),
  );
  register(
    "aquakart_delete_subcategory",
    {
      title: "Delete subcategory",
      description:
        "Permanently delete a subcategory. Refused with SUBCATEGORY_IN_USE while products use it.",
      scopes: [MCP_SCOPES.categoriesWrite],
      input: z.strictObject({
        idempotencyKey,
        subCategoryId: objectId,
        expectedRevision,
      }),
      output: envelope(deleted("subCategoryId"), true),
      annotations: DELETE,
    },
    (args, ctx) => tools.deleteSubCategory(args, ctx),
  );

  // ---- Page SEO ------------------------------------------------------
  register(
    "aquakart_list_seo",
    {
      title: "List page SEO",
      description:
        "SEO settings of storefront pages (pageKey, route, meta title/description, canonical, social tags, JSON-LD), sorted by pageKey.",
      scopes: [MCP_SCOPES.seoRead],
      input: z.strictObject({
        query: z
          .string()
          .max(100)
          .optional()
          .describe("Search pageKey, route or title"),
        active: z.boolean().optional(),
        page: z.number().int().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: envelope({
        pages: z.array(seoPage),
        page: z.number(),
        limit: z.number(),
        total: z.number(),
      }),
      annotations: READ,
    },
    (args) => tools.listSeo(args),
  );
  register(
    "aquakart_get_seo",
    {
      title: "Get page SEO",
      description: "One page's SEO settings by seoId or pageKey.",
      scopes: [MCP_SCOPES.seoRead],
      input: z
        .strictObject({
          seoId: objectId.optional(),
          pageKey: PAGE_KEY.optional(),
        })
        .refine((value) => Boolean(value.seoId) !== Boolean(value.pageKey), {
          message: "Provide exactly one of seoId or pageKey",
        }),
      output: envelope({ seo: seoPage }),
      annotations: READ,
    },
    (args) => tools.getSeo(args),
  );
  register(
    "aquakart_get_seo_readiness",
    {
      title: "SEO readiness of all pages",
      description:
        "Audit of every storefront page (static pages, products, categories, subcategories, blogs): status (READY / INCOMPLETE / NEEDS_SEO), priority P0-P3, score, missing fields, issues and recommended actions, worst first, plus a site summary.",
      scopes: [MCP_SCOPES.seoRead],
      input: z.strictObject({
        pageKey: PAGE_KEY.optional(),
        entityType: z
          .enum(["static", "product", "category", "subcategory", "blog"])
          .optional(),
        status: z.enum(["READY", "INCOMPLETE", "NEEDS_SEO"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: envelope({
        generatedAt: z.string(),
        summary: z.record(z.string(), z.number()),
        nextBestAction: z
          .object({
            pageKey: z.string(),
            route: z.string(),
            priority: z.string(),
            score: z.number().nullable(),
            reason: z.string(),
          })
          .nullable(),
        pages: z.array(readinessPage),
      }),
      annotations: READ,
    },
    (args) => tools.getSeoReadiness(args),
  );
  register(
    "aquakart_create_seo",
    {
      title: "Create page SEO",
      description:
        "Create SEO settings for a storefront page (applies to the live site at once). pageKey must be unique; use aquakart_get_seo_readiness to find pages with no SEO record and their pageKey/route.",
      scopes: [MCP_SCOPES.seoWrite],
      input: z.strictObject({
        idempotencyKey,
        pageKey: PAGE_KEY,
        ...seoFields,
        description: seoFields.description.optional(),
        keywords: seoFields.keywords.optional(),
        canonicalUrl: seoFields.canonicalUrl.optional(),
        robots: seoFields.robots.optional(),
        ogTitle: seoFields.ogTitle.optional(),
        ogDescription: seoFields.ogDescription.optional(),
        ogImage: seoFields.ogImage.optional(),
        twitterTitle: seoFields.twitterTitle.optional(),
        twitterDescription: seoFields.twitterDescription.optional(),
        twitterImage: seoFields.twitterImage.optional(),
        schemaJson: seoFields.schemaJson.optional(),
        aiLocked: seoFields.aiLocked.optional(),
        active: z.boolean().optional(),
      }),
      output: envelope({ seo: seoPage }, true),
      annotations: WRITE,
    },
    (args, ctx) => tools.createSeo(args, ctx),
  );
  register(
    "aquakart_update_seo",
    {
      title: "Update page SEO",
      description:
        "Edit a page's SEO settings (live at once). Omitted fields stay unchanged; empty strings clear text fields. active: false switches the page's SEO record off (there is no hard delete).",
      scopes: [MCP_SCOPES.seoWrite],
      input: z.strictObject({
        idempotencyKey,
        seoId: objectId,
        expectedRevision,
        pageKey: PAGE_KEY.optional(),
        ...optional(seoFields),
        active: z.boolean().optional(),
      }),
      output: envelope({ seo: seoPage }, true),
      annotations: WRITE,
    },
    (args, ctx) => tools.updateSeo(args, ctx),
  );
};
