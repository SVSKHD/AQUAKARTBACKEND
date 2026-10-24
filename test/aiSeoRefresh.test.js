import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  buildSeoPrompt,
  buildSeoUpdate,
  resolveSettings,
  selectPages,
} from "../src/jobs/aiSeoRefresh.js";
import { validateActionParams } from "../src/services/scheduler/actions.js";

const NOW = new Date("2026-10-25T03:30:00.000Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const entity = (pageKey, title, extra = {}) => ({
  entityType: "product",
  entityId: pageKey,
  title,
  pageKey,
  route: `/product/${pageKey}`,
  source: { title, ...extra },
  ...extra.entity,
});

const catalog = [
  {
    entityType: "category",
    entityId: "cat-soft",
    title: "Water Softeners",
    pageKey: "category.water-softeners",
    route: "/category/Water%20Softeners",
    source: {},
  },
  entity("product.ro-basic", "RO Purifier Basic"),
  entity("product.aquasoft", "AquaSoft 20L", { category: "cat-soft" }),
  entity("product.locked", "Locked Softener"),
  entity("product.fresh", "Fresh Softener"),
  entity("product.staff", "Staff Edited Purifier"),
  entity("product.old", "Old Purifier"),
  {
    entityType: "static",
    entityId: "privacy-policy",
    title: "Privacy policy",
    pageKey: "privacy-policy",
    route: "/privacy-policy",
    source: null,
  },
];

const seoByKey = new Map([
  ["product.locked", { pageKey: "product.locked", aiLocked: true }],
  [
    "product.fresh",
    {
      pageKey: "product.fresh",
      aiRefreshedAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
  ],
  [
    "product.staff",
    {
      pageKey: "product.staff",
      updatedBy: "staff-1",
      updatedAt: daysAgo(5),
      aiRefreshedAt: daysAgo(60),
    },
  ],
  [
    "product.old",
    {
      pageKey: "product.old",
      title: "Old",
      aiRefreshedAt: daysAgo(90),
      updatedAt: daysAgo(90),
    },
  ],
  ["product.ro-basic", { pageKey: "product.ro-basic", title: "RO" }],
]);

test("selects softener pages first and skips locked, fresh, staff and legal pages", () => {
  const pages = selectPages(catalog, seoByKey, resolveSettings(), NOW);
  assert.deepEqual(
    pages.map((page) => page.entity.pageKey),
    [
      // softener pages (category by name, product by its category)
      "category.water-softeners",
      "product.aquasoft",
      // never refreshed before refreshed
      "product.ro-basic",
      "product.old",
    ],
  );
  assert.equal(pages[1].categoryTitle, "Water Softeners");
});

test("settings come from job params, then env, clamped to safe limits", (t) => {
  t.after(() => delete process.env.SEO_AI_BATCH_SIZE);
  process.env.SEO_AI_BATCH_SIZE = "7";
  assert.equal(resolveSettings().batchSize, 7);
  assert.equal(resolveSettings({ batchSize: 500 }).batchSize, 20);
  assert.equal(
    resolveSettings({ maxBatches: 0 }).maxBatches,
    DEFAULTS.maxBatches,
  );
  assert.equal(resolveSettings({ focus: " softeners " }).focus, "softeners");
});

const generated = {
  pageKey: "product.old",
  title: "Automatic Water Softener for Homes in Hyderabad | AquaKart",
  description:
    "Buy an automatic water softener for hard borewell water in Hyderabad. Protect taps, skin and appliances. Book a free water test with AquaKart today.",
  keywords: [
    "water softener",
    "Water Softener",
    "hard water softener",
    "softener hyderabad",
  ],
};

test("updates existing records, keeps rollback values and custom social copy", () => {
  const page = {
    entity: catalog[6],
    seo: {
      _id: "seo-old",
      title: "Old",
      description: "Old description",
      keywords: ["old"],
      ogTitle: "Old",
      ogDescription: "Hand-written social text",
    },
  };
  const update = buildSeoUpdate(generated, page, NOW);
  assert.equal(update.id, "seo-old");
  assert.equal(update.set.title, generated.title);
  assert.deepEqual(update.set.keywords, [
    "water softener",
    "hard water softener",
    "softener hyderabad",
  ]);
  assert.equal(update.set.ogTitle, generated.title); // mirrored the old title
  assert.equal(update.set.ogDescription, undefined); // hand-written, kept
  assert.equal(update.set.twitterDescription, generated.description); // empty
  assert.deepEqual(update.set.aiPrevious.keywords, ["old"]);
  assert.equal(update.set.aiRefreshedAt, NOW);
});

test("creates records for pages without SEO and rejects thin output", () => {
  const page = { entity: catalog[2], seo: null };
  const { create } = buildSeoUpdate(generated, page, NOW);
  assert.equal(create.pageKey, "product.aquasoft");
  assert.equal(
    create.canonicalUrl,
    "https://aquakart.co.in/product/product.aquasoft",
  );
  assert.equal(create.robots, "index,follow");

  assert.equal(buildSeoUpdate(undefined, page, NOW), null);
  assert.equal(
    buildSeoUpdate({ ...generated, keywords: ["one"] }, page, NOW),
    null,
  );
});

test("prompt carries every page key and the weekly focus", () => {
  const pages = selectPages(catalog, seoByKey, resolveSettings(), NOW);
  const prompt = buildSeoPrompt(pages, "water softeners Hyderabad");
  for (const page of pages)
    assert.match(prompt, new RegExp(page.entity.pageKey));
  assert.match(prompt, /This week's focus: water softeners Hyderabad/);
  assert.match(prompt, /currentTitle: RO/);
});

test("job params are validated by the scheduler", () => {
  assert.deepEqual(
    validateActionParams("seo.ai_refresh", {
      batchSize: "5",
      focus: "softeners",
    }),
    { params: { batchSize: 5, focus: "softeners" } },
  );
});
