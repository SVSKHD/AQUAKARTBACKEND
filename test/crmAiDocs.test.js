import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { applyCrmAiDocs } from "../src/docs/crmAi.js";

const require = createRequire(import.meta.url);
const requireSwagger = createRequire(require.resolve("swagger-jsdoc"));
const parser = requireSwagger("@apidevtools/swagger-parser");

test("CRM chat and generation Swagger contracts validate and remain staff-authenticated", async () => {
  const doc = applyCrmAiDocs({
    swagger: "2.0",
    info: { title: "CRM AI", version: "1" },
    paths: {},
  });
  assert.deepEqual(applyCrmAiDocs(structuredClone(doc)), doc);
  let operations = 0;
  for (const item of Object.values(doc.paths)) {
    for (const operation of Object.values(item)) {
      assert.deepEqual(operation.security, [{ CrmStaffToken: [] }]);
      assert.deepEqual(operation.tags, ["CRM / AI"]);
      operations++;
    }
  }
  assert.equal(operations, 7);
  await parser.validate(structuredClone(doc));
});
