import AquaProduct from "../models/product.js";
import AquaCategory from "../models/category.js";
import AquaSubCategory from "../models/sub-category.js";
import AquaBlog from "../models/blog.js";
import Seo from "../models/seo.js";

const STOREFRONT_URL = "https://aquakart.co.in";

const STATIC_PAGES = [
  ["home", "Home", "/"],
  ["shop", "Shop", "/shop"],
  ["categories", "Categories", "/categories"],
  ["blogs", "Blogs", "/blogs"],
  ["about", "About", "/about"],
  ["contact-us", "Contact", "/contact-us"],
  ["compare", "Compare", "/compare"],
  ["privacy-policy", "Privacy policy", "/privacy-policy"],
  ["shipping-policy", "Shipping policy", "/shipping-policy"],
  ["terms-and-conditions", "Terms and conditions", "/terms-and-conditions"],
  ["softener-planner", "Softener planner", "/softener-planner"],
  ["softeners-hyderabad", "Softeners Hyderabad", "/softeners-hyderabad"],
];

const normalizeKeyPart = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const routeSegment = (value) => encodeURIComponent(String(value || "").trim());

const stripHtml = (value) =>
  String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const wordCount = (value) => {
  const text = stripHtml(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
};

const hasImage = (photos) =>
  Array.isArray(photos) &&
  photos.some((photo) =>
    Boolean(typeof photo === "string" ? photo.trim() : photo?.secure_url || photo?.url),
  );

const canonicalFor = (route) =>
  `${STOREFRONT_URL}${route === "/" ? "" : route}`;

const issue = (code, severity, field, message, action) => ({
  code,
  severity,
  field,
  message,
  ...(action ? { action } : {}),
});

const makeEntity = ({ type, id, title, pageKey, route, source = null }) => ({
  entityType: type,
  entityId: id ? String(id) : null,
  title: String(title || pageKey),
  pageKey,
  route,
  source,
});

const buildCatalog = async () => {
  const [products, categories, subcategories, blogs] = await Promise.all([
    AquaProduct.find({}).lean(),
    AquaCategory.find({}).lean(),
    AquaSubCategory.find({}).lean(),
    AquaBlog.find({}).lean(),
  ]);

  const staticItems = STATIC_PAGES.map(([pageKey, title, route]) =>
    makeEntity({ type: "static", id: pageKey, title, pageKey, route }),
  );

  const productItems = products
    .map((product) => {
      const keySource = product.slug || product.title;
      const routeSource = product.slug || product._id;
      if (!keySource || !routeSource) return null;
      return makeEntity({
        type: "product",
        id: product._id,
        title: product.title,
        pageKey: `product.${normalizeKeyPart(keySource)}`,
        route: `/product/${routeSegment(routeSource)}`,
        source: product,
      });
    })
    .filter(Boolean);

  const categoryItems = categories
    .map((category) => {
      if (!category.title) return null;
      return makeEntity({
        type: "category",
        id: category._id,
        title: category.title,
        pageKey: `category.${normalizeKeyPart(category.title)}`,
        route: `/category/${routeSegment(category.title)}`,
        source: category,
      });
    })
    .filter(Boolean);

  const subcategoryItems = subcategories
    .map((subcategory) => {
      if (!subcategory.title) return null;
      return makeEntity({
        type: "subcategory",
        id: subcategory._id,
        title: subcategory.title,
        pageKey: `subcategory.${normalizeKeyPart(subcategory.title)}`,
        route: `/subcategory/${routeSegment(subcategory.title)}`,
        source: subcategory,
      });
    })
    .filter(Boolean);

  const blogItems = blogs
    .map((blog) => {
      const slug = blog.slug || blog._id;
      if (!slug) return null;
      return makeEntity({
        type: "blog",
        id: blog._id,
        title: blog.title,
        pageKey: `blog.${normalizeKeyPart(slug)}`,
        route: `/blog/${routeSegment(slug)}`,
        source: blog,
      });
    })
    .filter(Boolean);

  return [
    ...staticItems,
    ...productItems,
    ...categoryItems,
    ...subcategoryItems,
    ...blogItems,
  ];
};

const scoreSeo = (entity, seo) => {
  const issues = [];
  const missing = [];
  const expectedCanonical = canonicalFor(entity.route);

  if (!seo) {
    issues.push(
      issue(
        "MISSING_SEO_RECORD",
        "critical",
        "seo",
        "No SEO configuration exists for this pageKey",
        "CREATE_SEO",
      ),
    );
    missing.push("seo.record");
    return { score: 0, issues, missing };
  }

  const checks = [
    ["title", Boolean(seo.title?.trim()), 18, "MISSING_TITLE", "SEO title is missing"],
    ["description", Boolean(seo.description?.trim()), 18, "MISSING_META_DESCRIPTION", "Meta description is missing"],
    ["canonicalUrl", Boolean(seo.canonicalUrl?.trim()), 14, "MISSING_CANONICAL", "Canonical URL is missing"],
    ["robots", Boolean(seo.robots?.trim()), 8, "MISSING_ROBOTS", "Robots directive is missing"],
    ["ogTitle", Boolean(seo.ogTitle?.trim()), 8, "MISSING_OG_TITLE", "Open Graph title is missing"],
    ["ogDescription", Boolean(seo.ogDescription?.trim()), 8, "MISSING_OG_DESCRIPTION", "Open Graph description is missing"],
    ["ogImage", Boolean(seo.ogImage?.trim()), 8, "MISSING_OG_IMAGE", "Open Graph image is missing"],
    ["schemaJson", Boolean(seo.schemaJson), 12, "MISSING_SCHEMA", "Structured data is missing"],
    ["active", seo.active !== false, 6, "SEO_DISABLED", "SEO configuration is disabled"],
  ];

  let score = 0;
  checks.forEach(([field, pass, points, code, message]) => {
    if (pass) {
      score += points;
    } else {
      missing.push(`seo.${field}`);
      issues.push(issue(code, points >= 14 ? "high" : "medium", `seo.${field}`, message, "UPDATE_SEO"));
    }
  });

  if (seo.canonicalUrl && seo.canonicalUrl !== expectedCanonical) {
    score = Math.max(0, score - 8);
    issues.push(
      issue(
        "CANONICAL_ROUTE_MISMATCH",
        "high",
        "seo.canonicalUrl",
        `Canonical should match ${expectedCanonical}`,
        "UPDATE_SEO",
      ),
    );
  }

  if (String(seo.robots || "").toLowerCase().includes("noindex")) {
    score = Math.max(0, score - 20);
    issues.push(
      issue(
        "PAGE_NOINDEX",
        "critical",
        "seo.robots",
        "Page is configured as noindex",
        "UPDATE_SEO",
      ),
    );
  }

  return { score: Math.min(score, 100), issues, missing };
};

const scoreContent = (entity) => {
  if (entity.entityType === "static") {
    return { score: null, issues: [], missing: [] };
  }

  const source = entity.source || {};
  const words = wordCount(source.description);
  const issues = [];
  const missing = [];
  let score = 100;

  if (!source.description || words === 0) {
    score = 0;
    missing.push("content.description");
    issues.push(issue("MISSING_CONTENT", "high", "content.description", "Page content is missing", "UPDATE_ENTITY"));
  } else {
    const threshold = entity.entityType === "blog" ? 250 : 80;
    if (words < threshold) {
      score -= 40;
      issues.push(
        issue(
          "THIN_CONTENT",
          "medium",
          "content.description",
          `Content has about ${words} words; expand it with useful buyer/search information`,
          "IMPROVE_CONTENT",
        ),
      );
    }
  }

  if (!String(source.keywords || "").trim()) {
    score -= 10;
    missing.push("content.keywords");
    issues.push(issue("MISSING_TOPIC_TERMS", "low", "content.keywords", "No source keywords/topic terms are stored", "UPDATE_ENTITY"));
  }

  return { score: Math.max(0, score), issues, missing };
};

const scoreMedia = (entity, seo) => {
  if (entity.entityType === "static") {
    return {
      score: seo?.ogImage ? 100 : 0,
      issues: seo?.ogImage
        ? []
        : [issue("MISSING_SOCIAL_IMAGE", "medium", "seo.ogImage", "Social image is missing", "UPDATE_SEO")],
      missing: seo?.ogImage ? [] : ["seo.ogImage"],
    };
  }

  const source = entity.source || {};
  const imageOk = hasImage(source.photos) || hasImage(source.titleImages);
  return {
    score: imageOk ? 100 : 0,
    issues: imageOk
      ? []
      : [issue("MISSING_PRIMARY_IMAGE", "high", "media.image", "No usable page image was found", "UPDATE_ENTITY")],
    missing: imageOk ? [] : ["media.image"],
  };
};

const scoreMerchant = (entity) => {
  if (entity.entityType !== "product") {
    return { score: null, issues: [], missing: [] };
  }

  const product = entity.source || {};
  const checks = [
    ["product.title", Boolean(product.title), 12, "MISSING_PRODUCT_TITLE", "Product title is missing"],
    ["product.price", Number(product.price) > 0, 15, "MISSING_PRICE", "Product price is missing or invalid"],
    ["product.brand", Boolean(product.brand?.trim()), 12, "MISSING_BRAND", "Brand is missing"],
    ["product.image", hasImage(product.photos), 15, "MISSING_PRODUCT_IMAGE", "Product image is missing"],
    ["product.url", Boolean(product.slug || product._id), 10, "MISSING_PRODUCT_URL", "Product URL source is missing"],
    ["product.googleProductCategory", Boolean(product.googleProductCategory?.trim()), 12, "MISSING_GOOGLE_CATEGORY", "Google Product Category is missing"],
    ["product.condition", Boolean(product.condition), 8, "MISSING_CONDITION", "Product condition is missing"],
    ["product.identifier", product.identifierExists === false || Boolean(product.gtin?.trim() || product.mpn?.trim()), 10, "MISSING_IDENTIFIER", "GTIN or MPN is missing while identifierExists is true"],
    ["product.merchantEnabled", product.merchantEnabled !== false, 6, "MERCHANT_DISABLED", "Product is disabled for Merchant feed"],
  ];

  let score = 0;
  const issues = [];
  const missing = [];
  checks.forEach(([field, pass, points, code, message]) => {
    if (pass) score += points;
    else {
      missing.push(field);
      issues.push(issue(code, points >= 12 ? "high" : "medium", field, message, "UPDATE_PRODUCT"));
    }
  });

  return { score: Math.min(score, 100), issues, missing };
};

const scoreSchema = (entity, seo) => {
  if (!seo?.schemaJson) {
    return {
      score: 0,
      issues: [issue("MISSING_SCHEMA", "high", "seo.schemaJson", "Structured data is missing", "UPDATE_SEO")],
      missing: ["seo.schemaJson"],
    };
  }

  const rawType = seo.schemaJson?.["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType].filter(Boolean);
  const expected =
    entity.entityType === "product"
      ? "Product"
      : entity.entityType === "blog"
        ? "BlogPosting"
        : entity.entityType === "category" || entity.entityType === "subcategory"
          ? "CollectionPage"
          : null;

  if (expected && !types.includes(expected)) {
    return {
      score: 55,
      issues: [
        issue(
          "SCHEMA_TYPE_MISMATCH",
          "medium",
          "seo.schemaJson.@type",
          `Expected ${expected} schema for this entity type`,
          "UPDATE_SEO",
        ),
      ],
      missing: [],
    };
  }

  return { score: 100, issues: [], missing: [] };
};

const scoreTechnical = (entity, seo) => {
  const issues = [];
  let score = 100;

  if (!entity.route?.startsWith("/")) {
    score -= 50;
    issues.push(issue("INVALID_ROUTE", "critical", "route", "Route must start with /", "UPDATE_ENTITY"));
  }
  if (!seo) score -= 30;
  if (seo?.active === false) score -= 40;
  if (String(seo?.robots || "").toLowerCase().includes("noindex")) score -= 50;

  return { score: Math.max(0, score), issues, missing: [] };
};

const priorityFor = (issues, score) => {
  if (issues.some((item) => item.severity === "critical")) return "P0";
  if (issues.some((item) => item.severity === "high") || score < 60) return "P1";
  if (issues.length || score < 90) return "P2";
  return "P3";
};

const statusFor = (seo, issues, score) => {
  if (!seo) return "NEEDS_SEO";
  if (issues.length === 0 && score >= 90) return "READY";
  return "INCOMPLETE";
};

const buildItem = (entity, seo) => {
  const technical = scoreTechnical(entity, seo);
  const metadata = scoreSeo(entity, seo);
  const content = scoreContent(entity);
  const schema = scoreSchema(entity, seo);
  const merchant = scoreMerchant(entity);
  const media = scoreMedia(entity, seo);

  const dimensions = {
    technical: technical.score,
    metadata: metadata.score,
    content: content.score,
    schema: schema.score,
    merchant: merchant.score,
    media: media.score,
  };

  const applicable = Object.values(dimensions).filter((value) => Number.isFinite(value));
  const score = applicable.length
    ? Math.round(applicable.reduce((sum, value) => sum + value, 0) / applicable.length)
    : 0;

  const allIssues = [
    ...technical.issues,
    ...metadata.issues,
    ...content.issues,
    ...schema.issues,
    ...merchant.issues,
    ...media.issues,
  ];

  const dedupedIssues = [
    ...new Map(allIssues.map((item) => [`${item.code}:${item.field}`, item])).values(),
  ];
  const missing = [
    ...new Set([
      ...technical.missing,
      ...metadata.missing,
      ...content.missing,
      ...schema.missing,
      ...merchant.missing,
      ...media.missing,
    ]),
  ];

  const recommendedActions = [
    ...new Map(
      dedupedIssues
        .filter((item) => item.action)
        .map((item) => [
          `${item.action}:${item.field}`,
          { action: item.action, field: item.field, reason: item.message },
        ]),
    ).values(),
  ];

  const priority = priorityFor(dedupedIssues, score);
  return {
    pageKey: entity.pageKey,
    entityType: entity.entityType,
    entityId: entity.entityId,
    title: entity.title,
    route: entity.route,
    canonicalUrl: canonicalFor(entity.route),
    status: statusFor(seo, dedupedIssues, score),
    priority,
    score,
    scores: dimensions,
    missing,
    issues: dedupedIssues,
    recommendedActions,
    edit: {
      seo: `/dashboard?tab=seo&pageKey=${encodeURIComponent(entity.pageKey)}`,
      ...(entity.entityType === "product" && entity.entityId
        ? { product: `/dashboard?tab=products&productId=${entity.entityId}` }
        : {}),
    },
    lastSeoUpdateAt: seo?.updatedAt || null,
  };
};

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const buildSeoReadiness = async ({
  pageKey,
  entityType,
  status,
  limit,
} = {}) => {
  const catalog = await buildCatalog();
  const seoRecords = await Seo.find({}).lean();
  const seoByKey = new Map(seoRecords.map((record) => [record.pageKey, record]));

  let items = catalog.map((entity) => buildItem(entity, seoByKey.get(entity.pageKey)));

  if (pageKey) {
    items = items.filter((item) => item.pageKey === String(pageKey).trim().toLowerCase());
  }
  if (entityType) {
    items = items.filter((item) => item.entityType === entityType);
  }
  if (status) {
    items = items.filter((item) => item.status === status);
  }

  items.sort(
    (a, b) =>
      priorityRank[a.priority] - priorityRank[b.priority] ||
      a.score - b.score ||
      a.pageKey.localeCompare(b.pageKey),
  );

  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    items = items.slice(0, Math.min(Number(limit), 1000));
  }

  const allCatalogItems = catalog.map((entity) => buildItem(entity, seoByKey.get(entity.pageKey)));
  const summary = {
    totalPages: allCatalogItems.length,
    ready: allCatalogItems.filter((item) => item.status === "READY").length,
    needsSeo: allCatalogItems.filter((item) => item.status !== "READY").length,
    missingSeo: allCatalogItems.filter((item) => item.status === "NEEDS_SEO").length,
    critical: allCatalogItems.filter((item) => item.priority === "P0").length,
    high: allCatalogItems.filter((item) => item.priority === "P1").length,
    medium: allCatalogItems.filter((item) => item.priority === "P2").length,
    overallScore: allCatalogItems.length
      ? Math.round(allCatalogItems.reduce((sum, item) => sum + item.score, 0) / allCatalogItems.length)
      : 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    site: "aquakart.co.in",
    summary,
    nextBestAction: items[0]
      ? {
          pageKey: items[0].pageKey,
          route: items[0].route,
          priority: items[0].priority,
          score: items[0].score,
          reason: items[0].issues[0]?.message || "Highest-priority SEO readiness item",
        }
      : null,
    items,
  };
};
