import test from "node:test";
import assert from "node:assert/strict";
import { buildSeoPayload } from "../src/controllers/seo.js";

test("normalizes SEO keys and comma-separated keywords", () => {
  const payload = buildSeoPayload({
    pageKey: " Shop ",
    route: "/shop",
    title: "Water Treatment Products | Aquakart",
    keywords: "water softener, RO purifier, water softener",
    schemaJson: '{"@type":"CollectionPage"}',
  });
  assert.equal(payload.pageKey, "shop");
  assert.deepEqual(payload.keywords, ["water softener", "RO purifier"]);
  assert.deepEqual(payload.schemaJson, { "@type": "CollectionPage" });
});

test("rejects routes that are not application paths", () => {
  assert.throws(
    () => buildSeoPayload({ pageKey: "shop", route: "shop", title: "Shop" }),
    /route must start with/,
  );
});

test("rejects invalid schema JSON", () => {
  assert.throws(
    () =>
      buildSeoPayload({
        pageKey: "shop",
        route: "/shop",
        title: "Shop",
        schemaJson: "{",
      }),
    /valid JSON/,
  );
});

test("partial payloads allow one-field status updates", () => {
  assert.deepEqual(buildSeoPayload({ active: false }, { partial: true }), {
    active: false,
  });
});
