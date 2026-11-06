import { BlogToolError } from "./errors.js";
import { buildSeoPayload } from "../../controllers/seo.js";

// Category, subcategory and page-SEO operations behind the Aquakart MCP
// tools. Works on the existing AquaCategory / AquaSubCategory / AquaSeo
// documents through an injected `store` (unit-tested with fakes). Rules
// mirror the CRM routes:
// - deleting a category is refused while subcategories or products use it;
//   deleting a subcategory is refused while products use it
// - SEO pages are never hard-deleted (the CRM has no delete): set
//   active: false to switch a page off
// - replaced category/subcategory photos are NOT deleted from Cloudinary
//   (they may be shared CRM images); only references change
// - every write is idempotent (operations.js), audited, and updates accept
//   expectedRevision for optimistic concurrency

const iso = (value) => (value ? new Date(value).toISOString() : null);
export const revisionOf = (doc) => {
  const stamp = doc?.updatedAt || doc?.createdAt;
  return stamp ? new Date(stamp).toISOString() : "0";
};
const plain = (value) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const keywordString = (value) =>
  Array.isArray(value)
    ? [...new Set(value.map(plain).filter(Boolean))].join(", ")
    : plain(value);
const sameTitle = (a, b) => plain(a).toLowerCase() === plain(b).toLowerCase();

export const createTaxonomySeoTools = ({
  store,
  runOperation,
  audit = async () => {},
}) => {
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
  const audited = (action, ctx, operation, resourceType, resourceId, extra) =>
    audit({
      action,
      adminUserId: ctx.auth.adminUserId,
      resourceType,
      resourceId,
      metadata: {
        clientId: ctx.auth.clientId,
        operationId: operation.operationId,
        correlationId: ctx.correlationId,
        ...extra,
      },
    });
  const finish = (outcome) => ({
    ...outcome.result,
    operationId: outcome.operationId,
    replayed: outcome.replayed,
  });
  const checkRevision = (doc, expected) => {
    if (expected && expected !== revisionOf(doc))
      throw new BlogToolError(
        "REVISION_CONFLICT",
        "It changed since you read it; get it again and retry",
        { currentRevision: revisionOf(doc) },
      );
  };
  const conflictIfNull = (doc) => {
    if (!doc)
      throw new BlogToolError(
        "REVISION_CONFLICT",
        "It changed while updating; get it again and retry",
      );
    return doc;
  };

  const photosFrom = async (mediaIds) => {
    const photos = [];
    for (const mediaId of [...new Set(mediaIds)]) {
      const media = await store.findMediaById(mediaId);
      if (!media || media.status !== "active")
        throw new BlogToolError(
          "MEDIA_NOT_FOUND",
          "Upload each image with aquakart_upload_image first",
          { mediaId },
        );
      photos.push({ id: media.publicId, secure_url: media.secureUrl });
    }
    return photos;
  };
  const photosView = (photos) =>
    (photos || []).map(({ id, secure_url: url }) => ({
      id: id || "",
      secure_url: url || "",
    }));

  // ---- Categories ----------------------------------------------------
  const categoryView = (category, counts = {}) => ({
    categoryId: String(category._id),
    title: category.title || "",
    description: category.description || "",
    keywords: category.keywords || "",
    photos: photosView(category.photos),
    subCategoryCount: counts.subCategories ?? null,
    productCount: counts.products ?? null,
    revision: revisionOf(category),
    createdAt: iso(category.createdAt),
  });
  const loadCategory = async (categoryId) => {
    const category = await store.findCategory(categoryId);
    if (!category)
      throw new BlogToolError("CATEGORY_NOT_FOUND", "No category has that id");
    return category;
  };
  const categoryTitleFree = async (title, excludeId) => {
    const existing = await store.findCategoryByTitle(plain(title));
    if (existing && String(existing._id) !== String(excludeId))
      throw new BlogToolError(
        "DUPLICATE_TITLE",
        "A category with this title already exists",
        { categoryId: String(existing._id) },
      );
    return existing;
  };

  // ---- Subcategories -------------------------------------------------
  const subCategoryView = (sub, counts = {}) => ({
    subCategoryId: String(sub._id),
    title: sub.title || "",
    description: sub.description || "",
    keywords: sub.keywords || "",
    photos: photosView(sub.photos),
    category: sub.category?._id
      ? { id: String(sub.category._id), title: sub.category.title || "" }
      : sub.category
        ? { id: String(sub.category), title: "" }
        : null,
    productCount: counts.products ?? null,
    revision: revisionOf(sub),
    createdAt: iso(sub.createdAt),
  });
  const loadSubCategory = async (subCategoryId) => {
    const sub = await store.findSubCategory(subCategoryId);
    if (!sub)
      throw new BlogToolError(
        "SUBCATEGORY_NOT_FOUND",
        "No subcategory has that id",
      );
    return sub;
  };
  const subTitleFree = async (title, excludeId) => {
    const existing = await store.findSubCategoryByTitle(plain(title));
    if (existing && String(existing._id) !== String(excludeId))
      throw new BlogToolError(
        "DUPLICATE_TITLE",
        "A subcategory with this title already exists",
        { subCategoryId: String(existing._id) },
      );
    return existing;
  };
  const parentExists = async (categoryId) => {
    if (!(await store.findCategory(categoryId)))
      throw new BlogToolError("INVALID_REFERENCE", "Parent category not found");
  };

  // ---- SEO -----------------------------------------------------------
  const seoView = (seo) => ({
    seoId: String(seo._id),
    pageKey: seo.pageKey,
    route: seo.route,
    title: seo.title || "",
    description: seo.description || "",
    keywords: seo.keywords || [],
    canonicalUrl: seo.canonicalUrl || "",
    robots: seo.robots || "index,follow",
    ogTitle: seo.ogTitle || "",
    ogDescription: seo.ogDescription || "",
    ogImage: seo.ogImage || "",
    twitterTitle: seo.twitterTitle || "",
    twitterDescription: seo.twitterDescription || "",
    twitterImage: seo.twitterImage || "",
    schemaJson: seo.schemaJson ?? null,
    active: seo.active !== false,
    aiLocked: Boolean(seo.aiLocked),
    aiRefreshedAt: iso(seo.aiRefreshedAt),
    revision: revisionOf(seo),
    updatedAt: iso(seo.updatedAt),
  });
  const loadSeo = async ({ seoId, pageKey }) => {
    const seo = await store.findSeo({
      seoId,
      pageKey: pageKey ? pageKey.trim().toLowerCase() : undefined,
    });
    if (!seo)
      throw new BlogToolError(
        "SEO_NOT_FOUND",
        "No SEO page matches that id or pageKey",
      );
    return seo;
  };
  const seoPayload = (fields, partial) => {
    try {
      return buildSeoPayload(fields, { partial });
    } catch (error) {
      if (error?.statusCode)
        throw new BlogToolError("VALIDATION_FAILED", "Invalid SEO page", [
          { field: error.field || "seo", message: error.message },
        ]);
      throw error;
    }
  };
  const pageKeyFree = async (pageKey, excludeId) => {
    const existing = await store.findSeo({ pageKey });
    if (existing && String(existing._id) !== String(excludeId))
      throw new BlogToolError(
        "PAGE_KEY_TAKEN",
        "Another SEO page already uses this pageKey",
        { seoId: String(existing._id) },
      );
    return existing;
  };

  return {
    // ---- Categories --------------------------------------------------
    async listCategories({ query }) {
      const items = await store.listCategories({ query });
      const counts = await store.taxonomyCounts();
      return {
        categories: items.map((category) =>
          categoryView(category, {
            subCategories: counts.subCategories[String(category._id)] || 0,
            products: counts.categoryProducts[String(category._id)] || 0,
          }),
        ),
        total: items.length,
      };
    },

    async getCategory({ categoryId }) {
      const category = await loadCategory(categoryId);
      const subs = await store.listSubCategories({ category: categoryId });
      const counts = await store.taxonomyCounts();
      return {
        category: categoryView(category, {
          subCategories: subs.length,
          products: counts.categoryProducts[categoryId] || 0,
        }),
        subCategories: subs.map((sub) =>
          subCategoryView(sub, {
            products: counts.subCategoryProducts[String(sub._id)] || 0,
          }),
        ),
      };
    },

    async createCategory(args, ctx) {
      const title = plain(args.title);
      if (!title)
        throw new BlogToolError("VALIDATION_FAILED", "Title is required");
      const outcome = await run(
        ctx,
        "aquakart_create_category",
        args,
        async (operation) => {
          const existing = await store.findCategoryByTitle(title);
          if (existing?.mcpOperation === operation.operationId)
            return {
              result: {
                category: categoryView(
                  await loadCategory(String(existing._id)),
                ),
              },
            };
          await categoryTitleFree(title);
          const created = await store.createCategory({
            title,
            description: plain(args.description),
            keywords: keywordString(args.keywords || []),
            photos: await photosFrom(args.mediaIds),
            mcpOperation: operation.operationId,
          });
          await audited(
            "mcp.category.create",
            ctx,
            operation,
            "category",
            created._id,
          );
          return {
            result: {
              category: categoryView(created, {
                subCategories: 0,
                products: 0,
              }),
            },
          };
        },
      );
      return finish(outcome);
    },

    async updateCategory(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_update_category",
        args,
        async (operation) => {
          const current = await loadCategory(args.categoryId);
          checkRevision(current, args.expectedRevision);
          const set = {};
          if (args.title !== undefined) {
            set.title = plain(args.title);
            if (!set.title)
              throw new BlogToolError("VALIDATION_FAILED", "Title is required");
            await categoryTitleFree(set.title, args.categoryId);
          }
          if (args.description !== undefined)
            set.description = plain(args.description);
          if (args.keywords !== undefined)
            set.keywords = keywordString(args.keywords);
          if (args.mediaIds !== undefined)
            set.photos = await photosFrom(args.mediaIds);
          if (!Object.keys(set).length)
            throw new BlogToolError("VALIDATION_FAILED", "No fields to update");
          const updated = conflictIfNull(
            await store.updateCategory(
              args.categoryId,
              { updatedAt: current.updatedAt ?? null },
              set,
            ),
          );
          await audited(
            "mcp.category.update",
            ctx,
            operation,
            "category",
            args.categoryId,
            {
              fields: Object.keys(set),
            },
          );
          const warnings = [];
          if (set.title && !sameTitle(set.title, current.title))
            warnings.push("TITLE_CHANGED_STOREFRONT_URL");
          if (set.photos && current.photos?.length)
            warnings.push("OLD_PHOTOS_KEPT_IN_CLOUDINARY");
          return { result: { category: categoryView(updated), warnings } };
        },
      );
      return finish(outcome);
    },

    async deleteCategory(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_delete_category",
        args,
        async (operation) => {
          const category = await store.findCategory(args.categoryId);
          if (!category) {
            // Already gone (e.g. a crashed earlier attempt deleted it).
            return {
              result: {
                deleted: false,
                alreadyDeleted: true,
                categoryId: args.categoryId,
              },
            };
          }
          checkRevision(category, args.expectedRevision);
          const counts = await store.taxonomyCounts();
          const subCategories = counts.subCategories[args.categoryId] || 0;
          const products = counts.categoryProducts[args.categoryId] || 0;
          if (subCategories || products)
            throw new BlogToolError(
              "CATEGORY_IN_USE",
              "Cannot delete a category while subcategories or products use it",
              { subCategories, products },
            );
          await store.deleteCategory(args.categoryId);
          await audited(
            "mcp.category.delete",
            ctx,
            operation,
            "category",
            args.categoryId,
            {
              title: category.title,
            },
          );
          return {
            result: {
              deleted: true,
              alreadyDeleted: false,
              categoryId: args.categoryId,
            },
          };
        },
      );
      return finish(outcome);
    },

    // ---- Subcategories -----------------------------------------------
    async listSubCategories({ category, query }) {
      const items = await store.listSubCategories({ category, query });
      const counts = await store.taxonomyCounts();
      return {
        subCategories: items.map((sub) =>
          subCategoryView(sub, {
            products: counts.subCategoryProducts[String(sub._id)] || 0,
          }),
        ),
        total: items.length,
      };
    },

    async getSubCategory({ subCategoryId }) {
      const sub = await loadSubCategory(subCategoryId);
      const counts = await store.taxonomyCounts();
      return {
        subCategory: subCategoryView(sub, {
          products: counts.subCategoryProducts[subCategoryId] || 0,
        }),
      };
    },

    async createSubCategory(args, ctx) {
      const title = plain(args.title);
      if (!title)
        throw new BlogToolError("VALIDATION_FAILED", "Title is required");
      const outcome = await run(
        ctx,
        "aquakart_create_subcategory",
        args,
        async (operation) => {
          const existing = await store.findSubCategoryByTitle(title);
          if (existing?.mcpOperation === operation.operationId)
            return {
              result: {
                subCategory: subCategoryView(
                  await loadSubCategory(String(existing._id)),
                ),
              },
            };
          await subTitleFree(title);
          await parentExists(args.category);
          const created = await store.createSubCategory({
            title,
            description: plain(args.description),
            keywords: keywordString(args.keywords || []),
            photos: await photosFrom(args.mediaIds || []),
            category: args.category,
            mcpOperation: operation.operationId,
          });
          await audited(
            "mcp.subcategory.create",
            ctx,
            operation,
            "subcategory",
            created._id,
          );
          return {
            result: { subCategory: subCategoryView(created, { products: 0 }) },
          };
        },
      );
      return finish(outcome);
    },

    async updateSubCategory(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_update_subcategory",
        args,
        async (operation) => {
          const current = await loadSubCategory(args.subCategoryId);
          checkRevision(current, args.expectedRevision);
          const set = {};
          const warnings = [];
          if (args.title !== undefined) {
            set.title = plain(args.title);
            if (!set.title)
              throw new BlogToolError("VALIDATION_FAILED", "Title is required");
            await subTitleFree(set.title, args.subCategoryId);
            if (!sameTitle(set.title, current.title))
              warnings.push("TITLE_CHANGED_STOREFRONT_URL");
          }
          if (args.description !== undefined)
            set.description = plain(args.description);
          if (args.keywords !== undefined)
            set.keywords = keywordString(args.keywords);
          if (args.mediaIds !== undefined) {
            set.photos = await photosFrom(args.mediaIds);
            if (current.photos?.length)
              warnings.push("OLD_PHOTOS_KEPT_IN_CLOUDINARY");
          }
          if (args.category !== undefined) {
            await parentExists(args.category);
            const products = await store.productsInSubCategory(
              args.subCategoryId,
            );
            const parent = String(current.category?._id || current.category);
            if (products && args.category !== parent)
              throw new BlogToolError(
                "SUBCATEGORY_IN_USE",
                "Products use this subcategory under its current category; move or edit them in the CRM first",
                { products },
              );
            set.category = args.category;
          }
          if (!Object.keys(set).length)
            throw new BlogToolError("VALIDATION_FAILED", "No fields to update");
          const updated = conflictIfNull(
            await store.updateSubCategory(
              args.subCategoryId,
              { updatedAt: current.updatedAt ?? null },
              set,
            ),
          );
          await audited(
            "mcp.subcategory.update",
            ctx,
            operation,
            "subcategory",
            args.subCategoryId,
            {
              fields: Object.keys(set),
            },
          );
          return {
            result: { subCategory: subCategoryView(updated), warnings },
          };
        },
      );
      return finish(outcome);
    },

    async deleteSubCategory(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_delete_subcategory",
        args,
        async (operation) => {
          const sub = await store.findSubCategory(args.subCategoryId);
          if (!sub)
            return {
              result: {
                deleted: false,
                alreadyDeleted: true,
                subCategoryId: args.subCategoryId,
              },
            };
          checkRevision(sub, args.expectedRevision);
          const products = await store.productsInSubCategory(
            args.subCategoryId,
          );
          if (products)
            throw new BlogToolError(
              "SUBCATEGORY_IN_USE",
              "Cannot delete a subcategory while products use it",
              { products },
            );
          await store.deleteSubCategory(args.subCategoryId);
          await audited(
            "mcp.subcategory.delete",
            ctx,
            operation,
            "subcategory",
            args.subCategoryId,
            {
              title: sub.title,
            },
          );
          return {
            result: {
              deleted: true,
              alreadyDeleted: false,
              subCategoryId: args.subCategoryId,
            },
          };
        },
      );
      return finish(outcome);
    },

    // ---- SEO ---------------------------------------------------------
    async listSeo({ query, active, page = 1, limit = 20 }) {
      const { items, total } = await store.listSeo({
        query,
        active,
        skip: (page - 1) * limit,
        limit,
      });
      return { pages: items.map(seoView), page, limit, total };
    },

    async getSeo(args) {
      return { seo: seoView(await loadSeo(args)) };
    },

    async createSeo(args, ctx) {
      const { idempotencyKey: _key, ...fields } = args;
      const payload = seoPayload(fields, false);
      const outcome = await run(
        ctx,
        "aquakart_create_seo",
        args,
        async (operation) => {
          const existing = await store.findSeo({ pageKey: payload.pageKey });
          if (existing?.mcpOperation === operation.operationId)
            return { result: { seo: seoView(existing) } };
          await pageKeyFree(payload.pageKey);
          let created;
          try {
            created = await store.createSeo({
              ...payload,
              createdBy: ctx.auth.adminUserId,
              updatedBy: ctx.auth.adminUserId,
              mcpOperation: operation.operationId,
            });
          } catch (error) {
            if (error?.code === 11000)
              throw new BlogToolError(
                "PAGE_KEY_TAKEN",
                "Another SEO page already uses this pageKey",
              );
            throw error;
          }
          await audited("mcp.seo.create", ctx, operation, "seo", created._id, {
            pageKey: created.pageKey,
          });
          return { result: { seo: seoView(created) } };
        },
      );
      return finish(outcome);
    },

    async updateSeo(args, ctx) {
      const { idempotencyKey: _key, seoId, expectedRevision, ...fields } = args;
      if (!Object.values(fields).some((value) => value !== undefined))
        throw new BlogToolError("VALIDATION_FAILED", "No fields to update");
      const payload = seoPayload(fields, true);
      const outcome = await run(
        ctx,
        "aquakart_update_seo",
        args,
        async (operation) => {
          const current = await loadSeo({ seoId });
          checkRevision(current, expectedRevision);
          if (payload.pageKey && payload.pageKey !== current.pageKey)
            await pageKeyFree(payload.pageKey, seoId);
          if (payload.title !== undefined && !String(payload.title).trim())
            throw new BlogToolError("VALIDATION_FAILED", "Invalid SEO page", [
              { field: "title", message: "title cannot be empty" },
            ]);
          const updated = conflictIfNull(
            await store.updateSeo(
              seoId,
              { updatedAt: current.updatedAt ?? null },
              { ...payload, updatedBy: ctx.auth.adminUserId },
            ),
          );
          await audited("mcp.seo.update", ctx, operation, "seo", seoId, {
            fields: Object.keys(payload),
            pageKey: updated.pageKey,
          });
          return { result: { seo: seoView(updated) } };
        },
      );
      return finish(outcome);
    },

    async getSeoReadiness({ pageKey, entityType, status, limit = 50 }) {
      const report = await store.seoReadiness({
        pageKey,
        entityType,
        status,
        limit,
      });
      return {
        generatedAt: report.generatedAt,
        summary: report.summary,
        nextBestAction: report.nextBestAction
          ? {
              pageKey: report.nextBestAction.pageKey,
              route: report.nextBestAction.route,
              priority: report.nextBestAction.priority,
              score: report.nextBestAction.score,
              reason: report.nextBestAction.reason,
            }
          : null,
        pages: (report.items || []).map((item) => ({
          pageKey: item.pageKey,
          entityType: item.entityType,
          entityId: item.entityId ? String(item.entityId) : null,
          title: item.title || "",
          route: item.route,
          canonicalUrl: item.canonicalUrl,
          status: item.status,
          priority: item.priority,
          score: item.score,
          missing: item.missing || [],
          issues: (item.issues || []).map((issue) => ({
            code: String(issue.code || ""),
            severity: String(issue.severity || ""),
            field: String(issue.field || ""),
            message: String(issue.message || ""),
          })),
          recommendedActions: (item.recommendedActions || []).map((action) => ({
            action: String(action.action || ""),
            field: String(action.field || ""),
            reason: String(action.reason || ""),
          })),
          lastSeoUpdateAt: iso(item.lastSeoUpdateAt),
        })),
      };
    },
  };
};
