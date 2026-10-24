import AquaBlog from "../models/blog.js";
import AquaCategory from "../models/category.js";
import AquaSubCategory from "../models/sub-category.js";
import AquaProduct from "../models/product.js";
import { generateContent } from "../services/gemini.js";

// Daily job: Gemini writes complete, SEO-ready blog posts and saves them as
// drafts with no images. Staff add a title image and publish from the CRM.

const MAX_PROMPT_PRODUCTS = 60;
const MAX_PROMPT_TITLES = 80;
const MAX_DRAFTS_PER_RUN = 5;

const SYSTEM_INSTRUCTION = [
  "You are the senior content writer and SEO editor for AquaKart",
  "(aquakart.co.in), an Indian store selling water purifiers (RO, UV, UF),",
  "water softeners, filters, spares and installation/maintenance services,",
  "based in Hyderabad and serving customers across India.",
  "Write original, accurate, genuinely helpful articles for Indian households",
  "and businesses. Use Indian context (TDS, borewell/municipal/tanker water,",
  "hard water in Hyderabad and other cities, monsoon, BIS standards) where",
  "relevant. Never invent prices, stock, offers, statistics, certifications,",
  "testimonials or medical claims. Respond with JSON only.",
].join(" ");

const envCount = () => {
  const value = Math.trunc(Number(process.env.BLOG_AI_DRAFTS_PER_RUN));
  return Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_DRAFTS_PER_RUN)
    : 1;
};

export const slugify = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

const normalizeTitleKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const cleanText = (value, max) => {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
};

const cleanList = (value, maxItems, maxChars) => {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  const seen = new Set();
  return items
    .map((item) => cleanText(String(item ?? ""), maxChars))
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
};

// Images are added by staff, so drop any the model emits along with anything
// executable, and demote a stray <h1> (the page already renders the title).
export const sanitizeArticleHtml = (html) =>
  String(html || "")
    .replace(/```(?:html)?/gi, "")
    .replace(/<(script|style|iframe|object|embed|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(img|picture|source|video|audio|iframe|embed)\b[^>]*\/?>/gi, "")
    .replace(/<\/(picture|video|audio)>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<(\/?)h1\b/gi, "<$1h2")
    .trim();

const findById = (list, id) =>
  id ? list.find((item) => String(item._id) === String(id)) || null : null;

// Turns Gemini's JSON into an AquaBlog payload. Pure, so it is unit-tested.
export const normalizeGeneratedBlog = (
  raw,
  { categories = [], subCategories = [], products = [] } = {},
) => {
  if (!raw || typeof raw !== "object") return { error: "Response is not JSON" };

  const title = cleanText(raw.title, 120);
  if (title.length < 10) return { error: "Generated title is too short" };

  const description = sanitizeArticleHtml(raw.description);
  const wordCount = description
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  if (wordCount < 300) {
    return { error: `Generated article is too short (${wordCount} words)` };
  }

  const product = findById(products, raw.productId);
  let category = findById(categories, raw.categoryId);
  let subCategory = findById(subCategories, raw.subCategoryId);
  // Keep the taxonomy consistent: fill gaps from the product/subcategory and
  // drop a subcategory that does not belong to the chosen category.
  if (!category && subCategory) {
    category = findById(categories, subCategory.category);
  }
  if (!category && product) category = findById(categories, product.category);
  if (!subCategory && product?.subCategory) {
    subCategory = findById(subCategories, product.subCategory);
  }
  if (
    subCategory &&
    (!category || String(subCategory.category) !== String(category._id))
  ) {
    subCategory = null;
  }

  const keywords = cleanList(raw.keywords, 12, 60);
  const keyphrases = cleanList(raw.keyphrases, 6, 100);

  return {
    blog: {
      title,
      slug: slugify(raw.slug) || slugify(title),
      description,
      shortDescription: cleanText(raw.shortDescription, 160),
      summary: cleanText(raw.summary, 600),
      keywords: keywords.join(", "),
      keyphrases: keyphrases.join(", "),
      keyHighlights: cleanList(raw.keyHighlights, 6, 200),
      tags: cleanList(raw.tags, 8, 40),
      notes: cleanText(
        raw.notes ||
          "AI-generated draft. Review facts and add a title image before publishing.",
        300,
      ),
      brand: cleanText(raw.brand, 60) || "Aquakart",
      category: category?._id || null,
      subCategory: subCategory?._id || null,
      product: product?._id || null,
      titleImages: [],
      photos: [],
      status: "draft",
      generatedBy: "ai",
    },
  };
};

const formatTaxonomy = ({ categories, subCategories, products }) => {
  const categoryLines = categories.map((category) => {
    const subs = subCategories
      .filter((sub) => String(sub.category) === String(category._id))
      .map((sub) => `    - ${sub.title} (subCategoryId: ${sub._id})`);
    return [`- ${category.title} (categoryId: ${category._id})`, ...subs].join(
      "\n",
    );
  });
  const productLines = products.map(
    (product) =>
      `- ${product.title}${product.brand ? ` [${product.brand}]` : ""} (productId: ${product._id})`,
  );
  return { categoryLines, productLines };
};

export const buildBlogPrompt = ({
  categories,
  subCategories,
  products,
  existingTitles,
  focusCategory,
  now,
}) => {
  const { categoryLines, productLines } = formatTaxonomy({
    categories,
    subCategories,
    products,
  });
  const month = now.toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

  return `Write one new blog post for the AquaKart blog. Today is ${month}.

${focusCategory ? `Focus topic area: ${focusCategory.title}. Pick a specific, high-search-intent question in this area (buying guides, comparisons, troubleshooting, maintenance, water quality explainers, seasonal advice).` : "Pick a specific, high-search-intent topic about water purification or softening."}

Do NOT repeat or closely paraphrase any of these existing blog titles:
${existingTitles.length ? existingTitles.map((title) => `- ${title}`).join("\n") : "- (none yet)"}

Store categories (use the ids exactly as given, or null):
${categoryLines.join("\n") || "- (none)"}

Store products (optional; link one only if the article is genuinely about it):
${productLines.join("\n") || "- (none)"}

Return a JSON object with exactly these fields:
{
  "title": "SEO title, 50-60 characters, primary keyword near the start, compelling, no clickbait, no brand suffix",
  "slug": "short-lowercase-hyphenated-url-slug-with-primary-keyword (3-7 words)",
  "shortDescription": "Meta description, 140-160 characters, includes the primary keyword and a reason to click",
  "summary": "2-3 sentence plain-text summary of the article",
  "description": "The full article as clean HTML (see rules below)",
  "keywords": ["8-12 search keywords, primary keyword first, include India/Hyderabad variants where natural"],
  "keyphrases": ["4-6 long-tail key phrases people actually search"],
  "keyHighlights": ["4-6 one-sentence key takeaways"],
  "tags": ["4-8 short topic tags in Title Case"],
  "notes": "Editor note under 250 characters: what to fact-check plus a suggested title image idea",
  "brand": "Aquakart unless the article is about a specific product brand from the list",
  "categoryId": "best matching categoryId from the list, or null",
  "subCategoryId": "matching subCategoryId under that category, or null",
  "productId": "matching productId from the list, or null"
}

Article rules for "description":
- 1000-1500 words, written for Indian readers, friendly and expert.
- Use only these tags: <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <a>.
- No <h1>, no images, no image placeholders, no inline styles, no markdown.
- Start with a short intro paragraph that uses the primary keyword in the first 100 words.
- Use 4-7 descriptive <h2> sections (keyword variants in some headings), with <h3> where useful.
- Include at least one list and, where it helps, a comparison table.
- End with an "FAQs" <h2> containing 3-5 questions as <h3> with short answers, then a brief conclusion that suggests contacting AquaKart for a free water test or product advice.
- Internal links only to https://aquakart.co.in (e.g. https://aquakart.co.in/products); no external links.`;
};

const uniqueSlug = async (base) => {
  const root = base || `aquakart-blog-${Date.now()}`;
  let slug = root;
  for (let suffix = 2; await AquaBlog.exists({ slug }); suffix += 1) {
    slug = `${root}-${suffix}`;
  }
  return slug;
};

const loadContext = async () => {
  const [categories, subCategories, products, recentBlogs] = await Promise.all([
    AquaCategory.find({}).select("title").sort({ title: 1 }).lean(),
    AquaSubCategory.find({}).select("title category").lean(),
    AquaProduct.find({})
      .select("title brand category subCategory")
      .sort({ _id: -1 })
      .limit(MAX_PROMPT_PRODUCTS)
      .lean(),
    AquaBlog.find({})
      .select("title")
      .sort({ createdAt: -1 })
      .limit(MAX_PROMPT_TITLES)
      .lean(),
  ]);
  return {
    categories: categories.filter((category) => category.title),
    subCategories: subCategories.filter((sub) => sub.title),
    products: products.filter((product) => product.title),
    existingTitles: recentBlogs.map((blog) => blog.title).filter(Boolean),
  };
};

// Rotates the focus category by day so consecutive drafts cover the catalog.
const pickFocusCategory = (categories, now, offset) => {
  if (!categories.length) return null;
  const day = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  return categories[(day + offset) % categories.length];
};

const generateDraft = async (context, now, offset, generate) => {
  const prompt = buildBlogPrompt({
    ...context,
    focusCategory: pickFocusCategory(context.categories, now, offset),
    now,
  });
  const result = await generate({
    prompt,
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.8,
    maxOutputTokens: 8192,
    json: true,
    model: process.env.GEMINI_BLOG_MODEL || undefined,
  });

  let raw;
  try {
    raw = JSON.parse(result.text);
  } catch (_error) {
    throw new Error("Gemini returned invalid JSON");
  }
  const { blog, error } = normalizeGeneratedBlog(raw, context);
  if (error) throw new Error(error);

  const titleKey = normalizeTitleKey(blog.title);
  if (
    context.existingTitles.some(
      (title) => normalizeTitleKey(title) === titleKey,
    )
  ) {
    throw new Error(`Duplicate title "${blog.title}"`);
  }

  blog.slug = await uniqueSlug(blog.slug);
  const created = await AquaBlog.create(blog);
  return { created, model: result.model };
};

export const runAiBlogDrafts = async (
  now = new Date(),
  { count = envCount(), generate = generateContent } = {},
) => {
  const context = await loadContext();
  const drafts = [];
  const failures = [];

  for (let index = 0; index < count; index += 1) {
    try {
      const { created, model } = await generateDraft(
        context,
        now,
        index,
        generate,
      );
      // Later drafts in the same run must not repeat this one.
      context.existingTitles.unshift(created.title);
      drafts.push({
        id: String(created._id),
        title: created.title,
        slug: created.slug,
        model,
      });
    } catch (error) {
      failures.push({ message: String(error?.message || error) });
    }
  }

  if (!drafts.length && failures.length) {
    const error = new Error(
      `No blog drafts created: ${failures.map((f) => f.message).join("; ")}`,
    );
    error.result = { created: 0, failed: failures.length, failures };
    throw error;
  }
  return { created: drafts.length, failed: failures.length, drafts, failures };
};
