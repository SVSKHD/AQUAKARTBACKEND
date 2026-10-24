import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBlogPrompt,
  normalizeGeneratedBlog,
  sanitizeArticleHtml,
  slugify,
} from "../src/jobs/aiBlogDrafts.js";

const categories = [
  { _id: "c1", title: "Water Softeners" },
  { _id: "c2", title: "Water Purifiers" },
];
const subCategories = [
  { _id: "s1", title: "Automatic Softeners", category: "c1" },
  { _id: "s2", title: "RO Purifiers", category: "c2" },
];
const products = [
  { _id: "p1", title: "AquaSoft 20L", category: "c1", subCategory: "s1" },
];

const article = (words = 400) =>
  `<h1>Heading</h1><p>${"water ".repeat(words)}</p>`;

test("slugify builds clean URL slugs", () => {
  assert.equal(
    slugify("  Hard Water & Hair Fall: Café Guide 2026! "),
    "hard-water-and-hair-fall-cafe-guide-2026",
  );
  assert.equal(slugify(""), "");
});

test("sanitizes article HTML: no images, scripts or h1", () => {
  const html = sanitizeArticleHtml(
    '```html<h1>Title</h1><img src="x.jpg"><p onclick="x()">Hi</p><script>bad()</script><a href="javascript:alert(1)">l</a>```',
  );
  assert.equal(html, '<h2>Title</h2><p>Hi</p><a href="#">l</a>');
});

test("normalizes a generated blog into a draft without images", () => {
  const { blog, error } = normalizeGeneratedBlog(
    {
      title: "Best Water Softener for Hyderabad Homes: 2026 Buying Guide",
      slug: "Best Water Softener Hyderabad",
      description: article(),
      shortDescription: "x".repeat(200),
      summary: "Summary.",
      keywords: ["water softener", "Water Softener", "hard water"],
      keyphrases: "best softener for borewell water, softener price guide",
      keyHighlights: ["One", "Two"],
      tags: ["Softeners", "Hard Water"],
      brand: "",
      categoryId: "c2",
      subCategoryId: "s1",
      productId: "p1",
    },
    { categories, subCategories, products },
  );

  assert.equal(error, undefined);
  assert.equal(blog.status, "draft");
  assert.equal(blog.generatedBy, "ai");
  assert.deepEqual(blog.titleImages, []);
  assert.deepEqual(blog.photos, []);
  assert.equal(blog.slug, "best-water-softener-hyderabad");
  assert.ok(blog.shortDescription.length <= 160);
  assert.equal(blog.keywords, "water softener, hard water");
  assert.equal(
    blog.keyphrases,
    "best softener for borewell water, softener price guide",
  );
  assert.equal(blog.brand, "Aquakart");
  assert.ok(blog.notes);
  assert.ok(blog.description.startsWith("<h2>"));
  // s1 belongs to c1, not the chosen c2, so it is dropped.
  assert.equal(blog.category, "c2");
  assert.equal(blog.subCategory, null);
  assert.equal(blog.product, "p1");
});

test("fills taxonomy from the product and ignores unknown ids", () => {
  const { blog } = normalizeGeneratedBlog(
    {
      title: "How to Maintain Your Automatic Water Softener",
      description: article(),
      categoryId: "nope",
      productId: "p1",
    },
    { categories, subCategories, products },
  );
  assert.equal(blog.category, "c1");
  assert.equal(blog.subCategory, "s1");
  assert.equal(blog.slug, "how-to-maintain-your-automatic-water-softener");
});

test("rejects short or malformed output", () => {
  assert.ok(normalizeGeneratedBlog(null).error);
  assert.ok(
    normalizeGeneratedBlog({ title: "Hi", description: article() }).error,
  );
  assert.match(
    normalizeGeneratedBlog({
      title: "A long enough title here",
      description: article(50),
    }).error,
    /too short/,
  );
});

test("prompt lists taxonomy ids and existing titles to avoid", () => {
  const prompt = buildBlogPrompt({
    categories,
    subCategories,
    products,
    existingTitles: ["What Is TDS?"],
    focusCategory: categories[0],
    now: new Date("2026-10-23T02:30:00Z"),
  });
  assert.match(prompt, /Water Softeners \(categoryId: c1\)/);
  assert.match(prompt, /Automatic Softeners \(subCategoryId: s1\)/);
  assert.match(prompt, /AquaSoft 20L \(productId: p1\)/);
  assert.match(prompt, /- What Is TDS\?/);
  assert.match(prompt, /Focus topic area: Water Softeners/);
  assert.match(prompt, /no images/);
});
