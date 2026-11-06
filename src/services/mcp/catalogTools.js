import { BlogToolError } from "./errors.js";
import { sanitizeBlogHtml, stripText } from "../../validators/mcp/blog.js";

// Product catalogue and coupon operations behind the Aquakart MCP tools.
// Works on the existing AquaProduct / AquaCoupon documents through an
// injected `store` (unit-tested with fakes):
// - reads never return dealer prices (dpPrice), reviewer identities or the
//   customer ids a coupon is targeted at
// - products have no draft state, so a created product is live on the
//   storefront at once; it is kept out of the Google Merchant feed
//   (merchantEnabled: false) until staff enable it in the CRM
// - coupons are created as drafts unless status "active" is asked for
// - every write is idempotent (operations.js) and audited

const refOf = (value) =>
  value?._id ? { id: String(value._id), title: value.title || "" } : null;
const iso = (value) => (value ? new Date(value).toISOString() : null);
const escapeText = (value) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export const createCatalogTools = ({
  store,
  runOperation,
  now = () => new Date(),
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

  const audited = (action, ctx, operation, resourceType, resourceId) =>
    audit({
      action,
      adminUserId: ctx.auth.adminUserId,
      resourceType,
      resourceId,
      metadata: {
        clientId: ctx.auth.clientId,
        operationId: operation.operationId,
        correlationId: ctx.correlationId,
      },
    });

  const finish = (outcome) => ({
    ...outcome.result,
    operationId: outcome.operationId,
    replayed: outcome.replayed,
  });

  // ---- Products ------------------------------------------------------
  const productSummary = (product) => ({
    productId: String(product._id),
    title: product.title,
    shortName: product.ShortName || null,
    slug: product.slug || null,
    code: product.code || null,
    sku: product.sku || null,
    brand: product.brand || "",
    price: product.price ?? null,
    discountPrice:
      product.discountPriceStatus && product.discountPrice != null
        ? product.discountPrice
        : null,
    stock: product.stock ?? null,
    category: refOf(product.category),
    subCategory: refOf(product.subCategory),
    imageUrl: product.photos?.[0]?.secure_url || null,
    merchantEnabled: product.merchantEnabled !== false,
    createdAt: iso(product.createdAt),
  });

  const productFull = (product) => ({
    ...productSummary(product),
    description: product.description || "",
    keywords: product.keywords || "",
    notes: product.notes || "",
    gtin: product.gtin || null,
    mpn: product.mpn || null,
    condition: product.condition || "new",
    googleProductCategory: product.googleProductCategory || null,
    productType: product.productType || null,
    shippingWeight: product.shippingWeight || null,
    photos: (product.photos || []).map(({ id, secure_url: url }) => ({
      id,
      secure_url: url,
    })),
    ratings: product.ratings ?? 0,
    numberOfReviews: product.numberOfReviews ?? 0,
  });

  const loadProduct = async (productId) => {
    const product = await store.findProduct(productId);
    if (!product)
      throw new BlogToolError("PRODUCT_NOT_FOUND", "No product has that id");
    return product;
  };

  // ---- Coupons -------------------------------------------------------
  const couponView = (coupon) => ({
    couponId: String(coupon._id),
    code: coupon.code,
    description: coupon.description || "",
    status: coupon.status,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    maxDiscount: coupon.maxDiscount ?? null,
    minimumOrder: coupon.minimumOrder || 0,
    startsAt: iso(coupon.startsAt),
    endsAt: iso(coupon.endsAt),
    usageLimit: coupon.usageLimit ?? null,
    usageCount: coupon.usageCount || 0,
    perUserLimit: coupon.perUserLimit ?? 1,
    firstOrderOnly: Boolean(coupon.firstOrderOnly),
    stackable: Boolean(coupon.stackable),
    productIds: (coupon.productIds || []).map(String),
    categoryIds: (coupon.categoryIds || []).map(String),
    // Customer-targeted coupons only report how many accounts, never who.
    targetedAccounts: (coupon.userIds || []).length,
    createdAt: iso(coupon.createdAt),
  });

  const loadCoupon = async ({ couponId, code }) => {
    const coupon = await store.findCoupon({
      couponId,
      code: code ? code.trim().toUpperCase() : undefined,
    });
    if (!coupon)
      throw new BlogToolError(
        "COUPON_NOT_FOUND",
        "No coupon matches that id or code",
      );
    return coupon;
  };

  const checkIdsExist = async (kind, ids, exists) => {
    const unique = [...new Set(ids || [])];
    const missing = [];
    for (const id of unique) if (!(await exists(id))) missing.push(id);
    if (missing.length)
      throw new BlogToolError("INVALID_REFERENCE", `Unknown ${kind} id(s)`, {
        missing,
      });
    return unique;
  };

  return {
    async listProducts({ query, category, inStock, page = 1, limit = 20 }) {
      const { items, total } = await store.listProducts({
        query,
        category,
        inStock,
        skip: (page - 1) * limit,
        limit,
      });
      return { products: items.map(productSummary), page, limit, total };
    },

    async getProduct({ productId }) {
      return { product: productFull(await loadProduct(productId)) };
    },

    async createProduct(args, ctx) {
      const description = sanitizeBlogHtml(args.description);
      const errors = [];
      if (!stripText(description))
        errors.push({ field: "description", message: "has no text" });
      const title = escapeText(args.title);
      if (!title) errors.push({ field: "title", message: "is empty" });
      const brand = escapeText(args.brand);
      if (!brand) errors.push({ field: "brand", message: "is empty" });
      if (args.discountPrice != null && args.discountPrice >= args.price)
        errors.push({
          field: "discountPrice",
          message: "must be lower than price",
        });
      if (args.subCategory && !args.category)
        errors.push({
          field: "category",
          message: "is required with a subCategory",
        });
      if (errors.length)
        throw new BlogToolError("VALIDATION_FAILED", "Invalid product", errors);

      const outcome = await run(
        ctx,
        "aquakart_create_product",
        args,
        async (operation) => {
          const sameTitle = await store.findProductByTitle(title);
          if (sameTitle) {
            // A crashed earlier attempt of this very operation already saved it.
            if (sameTitle.mcpOperation === operation.operationId) {
              const saved = await loadProduct(String(sameTitle._id));
              return { result: { product: productSummary(saved) } };
            }
            throw new BlogToolError(
              "DUPLICATE_TITLE",
              "A product with this title already exists",
              { productId: String(sameTitle._id) },
            );
          }
          if (args.sku && (await store.productSkuTaken(args.sku))) {
            throw new BlogToolError(
              "DUPLICATE_SKU",
              "Another product already uses this SKU",
              { sku: args.sku },
            );
          }
          const taxonomyError = await store.taxonomyError({
            category: args.category || null,
            subCategory: args.subCategory || null,
          });
          if (taxonomyError)
            throw new BlogToolError("INVALID_REFERENCE", taxonomyError);

          const photos = [];
          for (const mediaId of [...new Set(args.mediaIds)]) {
            const media = await store.findMediaById(mediaId);
            if (!media || media.status !== "active") {
              throw new BlogToolError(
                "MEDIA_NOT_FOUND",
                "Upload each image with aquakart_upload_image first",
                { mediaId },
              );
            }
            photos.push({ id: media.publicId, secure_url: media.secureUrl });
          }

          const discount = args.discountPrice != null;
          const doc = {
            title,
            description,
            price: args.price,
            stock: args.stock,
            brand,
            photos,
            arPhotos: [],
            merchantEnabled: args.merchantEnabled ?? false,
            discountPriceStatus: discount,
            user: ctx.auth.adminUserId,
            createdAt: now(),
            mcpOperation: operation.operationId,
          };
          if (discount) {
            doc.discountPrice = args.discountPrice;
            doc.discountPricePercentage = Math.round(
              ((args.price - args.discountPrice) / args.price) * 100,
            );
          }
          if (args.category) doc.category = args.category;
          if (args.subCategory) doc.subCategory = args.subCategory;
          for (const field of [
            "slug",
            "code",
            "sku",
            "gtin",
            "mpn",
            "googleProductCategory",
            "productType",
            "shippingWeight",
            "condition",
          ]) {
            if (args[field]) doc[field] = escapeText(args[field]);
          }
          if (args.shortName) doc.ShortName = escapeText(args.shortName);
          if (args.notes) doc.notes = escapeText(args.notes);
          if (args.keywords?.length)
            doc.keywords = [
              ...new Set(args.keywords.map(escapeText).filter(Boolean)),
            ].join(", ");

          const created = await store.createProduct(doc);
          await audited(
            "mcp.product.create",
            ctx,
            operation,
            "product",
            created._id,
          );
          return { result: { product: productSummary(created) } };
        },
      );
      return finish(outcome);
    },

    async listCoupons({ status, query, page = 1, limit = 20 }) {
      const { items, total } = await store.listCoupons({
        status,
        query: query ? query.trim().toUpperCase() : undefined,
        skip: (page - 1) * limit,
        limit,
      });
      return { coupons: items.map(couponView), page, limit, total };
    },

    async getCoupon(args) {
      return { coupon: couponView(await loadCoupon(args)) };
    },

    async createCoupon(args, ctx) {
      const code = args.code.trim().toUpperCase();
      const startsAt = args.startsAt ? new Date(args.startsAt) : now();
      const endsAt = new Date(args.endsAt);
      const errors = [];
      if (!COUPON_CODE.test(code))
        errors.push({
          field: "code",
          message: "3-32 letters, digits, '_' or '-'",
        });
      if (args.discountType === "percentage" && args.discountValue > 100)
        errors.push({
          field: "discountValue",
          message: "a percentage cannot exceed 100",
        });
      if (endsAt <= startsAt)
        errors.push({ field: "endsAt", message: "must be after startsAt" });
      if (endsAt <= now())
        errors.push({ field: "endsAt", message: "must be in the future" });
      if (errors.length)
        throw new BlogToolError("VALIDATION_FAILED", "Invalid coupon", errors);

      const outcome = await run(
        ctx,
        "aquakart_create_coupon",
        args,
        async (operation) => {
          const existing = await store.findCoupon({ code });
          if (existing) {
            if (existing.mcpOperation === operation.operationId) {
              return { result: { coupon: couponView(existing) } };
            }
            throw new BlogToolError(
              "COUPON_CODE_TAKEN",
              "A coupon with this code already exists",
              { couponId: String(existing._id), status: existing.status },
            );
          }
          const productIds = await checkIdsExist(
            "product",
            args.productIds,
            store.productExists,
          );
          const categoryIds = await checkIdsExist(
            "category",
            args.categoryIds,
            store.categoryExists,
          );
          let created;
          try {
            created = await store.createCoupon({
              code,
              description: escapeText(args.description || ""),
              discountType: args.discountType,
              discountValue: args.discountValue,
              maxDiscount: args.maxDiscount ?? null,
              minimumOrder: args.minimumOrder ?? 0,
              startsAt,
              endsAt,
              usageLimit: args.usageLimit ?? null,
              perUserLimit: args.perUserLimit ?? 1,
              firstOrderOnly: args.firstOrderOnly ?? false,
              stackable: args.stackable ?? false,
              productIds,
              categoryIds,
              status: args.status || "draft",
              createdBy: ctx.auth.adminUserId,
              updatedBy: ctx.auth.adminUserId,
              mcpOperation: operation.operationId,
            });
          } catch (error) {
            if (error?.code === 11000)
              throw new BlogToolError(
                "COUPON_CODE_TAKEN",
                "A coupon with this code already exists",
              );
            throw error;
          }
          await audited(
            "mcp.coupon.create",
            ctx,
            operation,
            "coupon",
            created._id,
          );
          return { result: { coupon: couponView(created) } };
        },
      );
      return finish(outcome);
    },
  };
};
