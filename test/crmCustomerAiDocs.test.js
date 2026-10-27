import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { applyCrmCustomerAiDocs } from "../src/docs/crmCustomerAi.js";
const require = createRequire(import.meta.url);
const parser = createRequire(require.resolve("swagger-jsdoc"))(
  "@apidevtools/swagger-parser",
);

test("six customer AI editorial operations have valid Swagger and staff authentication", async () => {
  const doc = applyCrmCustomerAiDocs({
    swagger: "2.0",
    info: { title: "CRM Customer AI", version: "1" },
    paths: {},
  });
  assert.deepEqual(applyCrmCustomerAiDocs(structuredClone(doc)), doc);
  let count = 0;
  for (const item of Object.values(doc.paths))
    for (const operation of Object.values(item)) {
      assert.deepEqual(operation.security, [{ CrmCustomerAiStaff: [] }]);
      count++;
    }
  assert.equal(count, 6);
  await parser.validate(structuredClone(doc));
});
