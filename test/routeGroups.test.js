import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyRouteGroups,
  discoverRouteGroups,
} from "../src/docs/routeGroups.js";

test("mounted routes inherit module/folder groups without changing their contracts", async () => {
  const groups = await discoverRouteGroups();
  assert.equal(groups.get("get /v1/all-products"), "Products");
  assert.equal(groups.get("post /v1/login"), "Auth");
  assert.equal(groups.get("get /v1/crm/admin/all-invoices"), "CRM / Invoices");
  assert.equal(groups.get("post /v1/crm/quotations"), "CRM / Quotations");
  const operation = {
    responses: { 200: { description: "OK" } },
    parameters: [],
  };
  const doc = {
    paths: { "/v1/crm/quotations/": { post: structuredClone(operation) } },
  };
  await applyRouteGroups(doc);
  assert.deepEqual(doc.paths["/v1/crm/quotations/"].post, {
    ...operation,
    tags: ["CRM / Quotations"],
  });
  assert.deepEqual(await applyRouteGroups(structuredClone(doc)), doc);
});

test("new folders and nested routers are discovered automatically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swagger-groups-"));
  try {
    await fs.mkdir(path.join(root, "src/routes/warehouse"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "app.js"),
      'import warehouse from "./src/routes/warehouse/index.js"; app.use("/v1/warehouse", warehouse);',
    );
    await fs.writeFile(
      path.join(root, "src/routes/warehouse/index.js"),
      'import bins from "./bins.js"; router.use("/bins", bins);',
    );
    await fs.writeFile(
      path.join(root, "src/routes/warehouse/bins.js"),
      'router.patch("/:id", updateBin);',
    );
    const doc = {
      paths: { "/v1/warehouse/bins/{id}": { patch: { responses: {} } } },
    };
    await applyRouteGroups(doc, path.join(root, "app.js"));
    assert.deepEqual(doc.paths["/v1/warehouse/bins/{id}"].patch.tags, [
      "Warehouse / Bins",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
