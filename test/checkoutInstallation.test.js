import assert from "node:assert/strict";
import test from "node:test";
import { installationFrom } from "../src/services/checkout.js";

test("keeps a well-formed installation slot from checkout", () => {
  assert.deepEqual(
    installationFrom({ day: "2026-10-30", slot: " 12 pm – 3 pm " }),
    { day: "2026-10-30", slot: "12 pm – 3 pm" },
  );
});

test("drops a missing or malformed slot instead of failing the order", () => {
  assert.equal(installationFrom(undefined), undefined);
  assert.equal(
    installationFrom({ day: "30/10/2026", slot: "9 am" }),
    undefined,
  );
  assert.equal(installationFrom({ day: "2026-10-30", slot: "" }), undefined);
});
