import Seo from "../models/seo.js";
import { generateContent } from "../services/gemini.js";
import {
  buildCatalog,
  canonicalFor,
  stripHtml,
} from "../services/seoReadiness.js";

// Weekly SEO agent: rewrites the meta title, description and keywords of a
// small batch of pages per run. Several pages go into one Gemini call and a
// run is capped at a few calls, so token use stays predictable. Softener pages
// go first, the rest of the site rotates through, and pages staff locked or
// recently edited by hand are left alone.

const DAY_MS = 24 * 60 * 60 * 1000;
const SOFTENER_PATTERN =
  /soften|hard[\s-]*water|resin|salt[\s-]*free|scal(e|ing)/i;
// Legal pages gain nothing from keyword work.
const SKIPPED_PAGE_KEYS = new Set([
  "privacy-policy",
  "shipping-policy",
  "terms-and-conditions",
]);
const SOURCE_CHARS = 400;

export const DEFAULTS = Object.freeze({
  batchSize: 10,
  maxBatches: 3,
  minDaysBetweenRefresh: 28,
  staffEditGraceDays: 30,
});
const LIMITS = Object.freeze({ batchSize: 20, maxBatches: 10 });

const SYSTEM_INSTRUCTION = [
  "You are the SEO specialist for AquaKart (aquakart.co.in), a Hyderabad-based",
  "Indian store whose core business is water softeners (automatic and manual,",
  "for homes, apartments and businesses), alongside water purifiers, filters,",
  "spares and installation/service. Write search-friendly metadata for Indian",
  "buyers. Lean towards water softener and hard-water search intent wherever",
  "the page is genuinely about it; otherwise stay accurate to the page.",
  "Never invent prices, discounts, stock, ratings or certifications.",
  "Respond with JSON only.",
].join(" ");

const clampInt = (value, fallback, min, max) => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= min
    ? Math.min(number, max)
    : fallback;
};

// Job params (editable on the scheduled job in the CRM) override env defaults.
export const resolveSettings = (params = {}) => ({
  batchSize: clampInt(
    params.batchSize ?? process.env.SEO_AI_BATCH_SIZE,
    DEFAULTS.batchSize,
    1,
    LIMITS.batchSize,
  ),
  maxBatches: clampInt(
    params.maxBatches ?? process.env.SEO_AI_BATCHES_PER_RUN,
    DEFAULTS.maxBatches,
    1,
    LIMITS.maxBatches,
  ),
  minDaysBetweenRefresh: clampInt(
    process.env.SEO_AI_MIN_DAYS_BETWEEN_REFRESH,
    DEFAULTS.minDaysBetweenRefresh,
    1,
    365,
  ),
  staffEditGraceDays: clampInt(
    process.env.SEO_AI_STAFF_EDIT_GRACE_DAYS,
    DEFAULTS.staffEditGraceDays,
    0,
    365,
  ),
  focus: typeof params.focus === "string" ? params.focus.trim() : "",
});

const truncate = (value, max) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
};

const keywordList = (value) =>
  (Array.isArray(value) ? value : String(value ?? "").split(/[,\n]/))
    .map((item) => truncate(item, 60))
    .filter(Boolean);

const isSoftenerPage = (entity, categoryTitles) =>
  SOFTENER_PATTERN.test(
    [
      entity.title,
      entity.route,
      entity.source?.keywords,
      categoryTitles.get(String(entity.source?.category)),
    ]
      .filter(Boolean)
      .join(" "),
  );

// A staff save after the last AI refresh (beyond the few ms between our own
// $set and Mongoose's updatedAt) means a human owns the current copy.
const staffEditedRecently = (seo, now, graceDays) => {
  if (!seo?.updatedBy || !seo.updatedAt) return false;
  const updatedAt = new Date(seo.updatedAt).getTime();
  const refreshedAt = seo.aiRefreshedAt
    ? new Date(seo.aiRefreshedAt).getTime()
    : 0;
  return (
    updatedAt - refreshedAt > 60 * 1000 &&
    now.getTime() - updatedAt < graceDays * DAY_MS
  );
};

// Orders eligible pages: softener pages, then never-refreshed (missing SEO
// records first), then least recently refreshed. Pure, so it is unit-tested.
export const selectPages = (catalog, seoByKey, settings, now = new Date()) => {
  const categoryTitles = new Map(
    catalog
      .filter((entity) => entity.entityType === "category")
      .map((entity) => [String(entity.entityId), entity.title]),
  );
  const refreshCutoff = now.getTime() - settings.minDaysBetweenRefresh * DAY_MS;

  return catalog
    .filter((entity) => !SKIPPED_PAGE_KEYS.has(entity.pageKey))
    .map((entity) => ({ entity, seo: seoByKey.get(entity.pageKey) || null }))
    .filter(({ seo }) => {
      if (!seo) return true;
      if (seo.aiLocked || seo.active === false) return false;
      if (/noindex/i.test(seo.robots || "")) return false;
      if (
        seo.aiRefreshedAt &&
        new Date(seo.aiRefreshedAt).getTime() > refreshCutoff
      ) {
        return false;
      }
      return !staffEditedRecently(seo, now, settings.staffEditGraceDays);
    })
    .map((page) => ({
      ...page,
      softener: isSoftenerPage(page.entity, categoryTitles),
      categoryTitle: categoryTitles.get(String(page.entity.source?.category)),
    }))
    .sort(
      (a, b) =>
        Number(b.softener) - Number(a.softener) ||
        Number(Boolean(a.seo?.aiRefreshedAt)) -
          Number(Boolean(b.seo?.aiRefreshedAt)) ||
        Number(Boolean(a.seo)) - Number(Boolean(b.seo)) ||
        new Date(a.seo?.aiRefreshedAt || 0) -
          new Date(b.seo?.aiRefreshedAt || 0) ||
        a.entity.pageKey.localeCompare(b.entity.pageKey),
    );
};

// Compact per-page context: enough to write good metadata, few tokens.
const describePage = ({ entity, seo, categoryTitle }) => {
  const source = entity.source || {};
  const lines = [
    `pageKey: ${entity.pageKey}`,
    `type: ${entity.entityType}`,
    `url: ${canonicalFor(entity.route)}`,
    `name: ${truncate(entity.title, 120)}`,
  ];
  if (source.brand) lines.push(`brand: ${truncate(source.brand, 60)}`);
  if (categoryTitle) lines.push(`category: ${truncate(categoryTitle, 80)}`);
  const content = stripHtml(
    source.shortDescription || source.summary || source.description,
  );
  if (content) lines.push(`content: ${truncate(content, SOURCE_CHARS)}`);
  if (seo?.title) lines.push(`currentTitle: ${truncate(seo.title, 120)}`);
  if (seo?.description) {
    lines.push(`currentDescription: ${truncate(seo.description, 300)}`);
  }
  const currentKeywords = seo?.keywords?.length
    ? seo.keywords
    : keywordList(source.keywords);
  if (currentKeywords.length) {
    lines.push(`currentKeywords: ${currentKeywords.slice(0, 15).join(", ")}`);
  }
  return lines.join("\n");
};

export const buildSeoPrompt = (
  pages,
  focus = "",
) => `Improve the SEO metadata for these ${pages.length} AquaKart pages.${focus ? `\nThis week's focus: ${focus}.` : ""}

${pages.map((page, index) => `### Page ${index + 1}\n${describePage(page)}`).join("\n\n")}

For EVERY page return an entry in:
{ "pages": [ { "pageKey": "exact pageKey from above", "title": "...", "description": "...", "keywords": ["..."] } ] }

Rules:
- title: 45-60 characters, primary keyword first, natural and specific to the page, may end with "| AquaKart" if it fits.
- description: 140-160 characters, primary keyword plus a clear benefit or call to action (e.g. free water test, installation in Hyderabad) only where accurate.
- keywords: 6-10 terms people in India actually search, most important first; include long-tail and Hyderabad/India variants where natural; no duplicates.
- Keep what already works in the current values; do not keyword-stuff.`;

const sameText = (a, b) =>
  String(a || "")
    .trim()
    .toLowerCase() ===
  String(b || "")
    .trim()
    .toLowerCase();

// Turns one generated entry into a Seo update for its page, or null.
export const buildSeoUpdate = (generated, page, now = new Date()) => {
  const title = truncate(generated?.title, 70);
  const description = truncate(generated?.description, 170);
  const seen = new Set();
  const keywords = keywordList(generated?.keywords)
    .filter((keyword) => {
      const key = keyword.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
  if (title.length < 15 || description.length < 50 || keywords.length < 3) {
    return null;
  }

  const { seo, entity } = page;
  const set = { title, description, keywords, aiRefreshedAt: now };
  // Social copy follows the meta copy only where it was empty or mirrored it,
  // so hand-written OG/Twitter text survives.
  for (const [field, oldValue, value] of [
    ["ogTitle", seo?.title, title],
    ["twitterTitle", seo?.title, title],
    ["ogDescription", seo?.description, description],
    ["twitterDescription", seo?.description, description],
  ]) {
    if (!seo?.[field] || sameText(seo[field], oldValue)) set[field] = value;
  }

  if (!seo) {
    return {
      create: {
        pageKey: entity.pageKey,
        route: entity.route,
        canonicalUrl: canonicalFor(entity.route),
        robots: "index,follow",
        ...set,
      },
    };
  }
  set.aiPrevious = {
    title: seo.title || "",
    description: seo.description || "",
    keywords: seo.keywords || [],
    replacedAt: now,
  };
  return { id: seo._id, set };
};

const applyBatch = async (pages, settings, now, generate) => {
  const result = await generate({
    prompt: buildSeoPrompt(pages, settings.focus),
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.4,
    // ~150 output tokens per page is plenty for title/description/keywords.
    maxOutputTokens: Math.min(8192, 400 + pages.length * 250),
    json: true,
    model: process.env.GEMINI_SEO_MODEL || undefined,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (_error) {
    throw new Error("Gemini returned invalid JSON");
  }
  const generatedByKey = new Map(
    (Array.isArray(parsed?.pages) ? parsed.pages : []).map((entry) => [
      String(entry?.pageKey || "")
        .trim()
        .toLowerCase(),
      entry,
    ]),
  );

  const updated = [];
  const skipped = [];
  for (const page of pages) {
    const update = buildSeoUpdate(
      generatedByKey.get(page.entity.pageKey),
      page,
      now,
    );
    if (!update) {
      // Left without aiRefreshedAt, so it is retried next run.
      skipped.push(page.entity.pageKey);
      continue;
    }
    try {
      if (update.create) {
        await Seo.create(update.create);
      } else {
        // Re-checks the lock in case staff locked the page mid-run.
        const { matchedCount } = await Seo.updateOne(
          { _id: update.id, aiLocked: { $ne: true } },
          { $set: update.set },
          { runValidators: true },
        );
        if (!matchedCount) {
          skipped.push(page.entity.pageKey);
          continue;
        }
      }
      updated.push({
        pageKey: page.entity.pageKey,
        title: (update.create || update.set).title,
        created: Boolean(update.create),
      });
    } catch (error) {
      console.error(`AI SEO update failed for ${page.entity.pageKey}:`, error);
      skipped.push(page.entity.pageKey);
    }
  }

  return {
    updated,
    skipped,
    tokens: Number(result.usage?.totalTokenCount) || 0,
    model: result.model,
  };
};

export const runAiSeoRefresh = async (
  now = new Date(),
  { params = {}, generate = generateContent } = {},
) => {
  const settings = resolveSettings(params);
  const [catalog, seoRecords] = await Promise.all([
    buildCatalog(),
    Seo.find({}).lean(),
  ]);
  const seoByKey = new Map(
    seoRecords.map((record) => [record.pageKey, record]),
  );
  const queue = selectPages(catalog, seoByKey, settings, now);

  const summary = {
    eligible: queue.length,
    batches: 0,
    updated: [],
    skipped: [],
    failures: [],
    totalTokens: 0,
    settings,
  };

  for (let batch = 0; batch < settings.maxBatches && queue.length; batch += 1) {
    const pages = queue.splice(0, settings.batchSize);
    summary.batches += 1;
    try {
      const result = await applyBatch(pages, settings, now, generate);
      summary.updated.push(...result.updated);
      summary.skipped.push(...result.skipped);
      summary.totalTokens += result.tokens;
      summary.model = result.model;
    } catch (error) {
      summary.failures.push({
        pages: pages.map((page) => page.entity.pageKey),
        message: String(error?.message || error),
      });
    }
  }

  summary.remaining = queue.length;
  if (summary.batches && !summary.updated.length && summary.failures.length) {
    const error = new Error(
      `AI SEO refresh failed: ${summary.failures.map((f) => f.message).join("; ")}`,
    );
    error.result = summary;
    throw error;
  }
  return summary;
};
