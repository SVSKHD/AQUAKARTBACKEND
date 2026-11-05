import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import blogRoutes from "../src/routes/blog.js";
import AquaBlog from "../src/models/blog.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";
import AquaProduct from "../src/models/product.js";

// Existing storefront/CRM blog behaviour must be unchanged by the MCP work:
// public reads hide drafts, draft listings stay staff-only, CRM create keeps
// its defaults, and partial updates keep existing images. Models are mocked.

const query = (result, seen) => {
  const chain = {
    populate: () => chain,
    sort: () => chain,
    select: () => chain,
    lean: () => chain,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  if (seen) seen.chain = chain;
  return chain;
};

const startApp = async (t) => {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "test-secret-for-blog-regression";
  const app = express();
  app.use(express.json());
  app.use("/v1", blogRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
};

const adminToken = (t) => {
  const adminId = "64b0000000000000000000aa";
  t.mock.method(AquaAdminUser, "findById", () => ({
    populate: async () => ({ _id: adminId, role: 1, status: "active" }),
  }));
  return jwt.sign({ _id: adminId }, process.env.JWT_SECRET);
};

test("storefront listing and slug lookups never return drafts", async (t) => {
  const base = await startApp(t);
  const filters = [];
  t.mock.method(AquaBlog, "find", (filter) => {
    filters.push(filter);
    return query([]);
  });
  t.mock.method(AquaBlog, "findOne", (filter) => {
    filters.push(filter);
    return query(null);
  });
  assert.equal((await fetch(`${base}/all-blogs`)).status, 200);
  assert.equal((await fetch(`${base}/blog-slug/a-draft`)).status, 404);
  assert.deepEqual(filters[0], { status: { $ne: "draft" } });
  assert.deepEqual(filters[1], { slug: "a-draft", status: { $ne: "draft" } });

  // Asking for drafts without a staff token is refused.
  assert.equal((await fetch(`${base}/all-blogs?status=draft`)).status, 401);
  assert.equal(
    (await fetch(`${base}/blog/64b000000000000000000001?status=all`)).status,
    401,
  );
});

test("staff can still list drafts and read a draft by id", async (t) => {
  const base = await startApp(t);
  const token = adminToken(t);
  const filters = [];
  t.mock.method(AquaBlog, "find", (filter) => {
    filters.push(filter);
    return query([{ _id: "1", title: "Draft", status: "draft" }]);
  });
  t.mock.method(AquaBlog, "findOne", (filter) => {
    filters.push(filter);
    return query({
      _id: filter._id,
      title: "Draft",
      status: "draft",
      category: null,
    });
  });
  t.mock.method(AquaProduct, "find", () => query([]));
  const response = await fetch(`${base}/all-blogs?status=draft`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(filters[0], { status: "draft" });
  const byId = await fetch(`${base}/blog/64b000000000000000000001?status=all`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(byId.status, 200);
  assert.deepEqual(filters[1], { _id: "64b000000000000000000001" });
});

test("CRM create keeps its payload/defaults and update keeps existing images", async (t) => {
  const base = await startApp(t);
  const token = adminToken(t);
  let created;
  t.mock.method(AquaBlog, "create", async (payload) => {
    created = payload;
    return { ...payload, _id: "b1", populate: async () => {} };
  });
  const response = await fetch(`${base}/blog-add`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Staff Written Blog",
      description: "<p>Body</p>",
      brand: "Aquakart",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(
    created.status,
    undefined,
    "status falls back to the model default (published)",
  );
  assert.equal(created.integration, undefined);
  assert.deepEqual(created.titleImages, []);
  assert.equal(AquaBlog.schema.path("status").defaultValue, "published");
  assert.deepEqual(AquaBlog.schema.path("generatedBy").enumValues, [
    "staff",
    "ai",
  ]);

  const titleImages = [
    {
      id: "Blogs/hero",
      secure_url: "https://res.cloudinary.com/demo/hero.jpg",
    },
  ];
  t.mock.method(AquaBlog, "findById", () => ({
    lean: async () => ({
      _id: "b1",
      title: "Staff Written Blog",
      titleImages,
      photos: [],
    }),
  }));
  let update;
  t.mock.method(AquaBlog, "findByIdAndUpdate", (id, payload) => {
    update = payload;
    return { populate: async () => ({ _id: id, ...payload }) };
  });
  const updated = await fetch(`${base}/blog-update/b1`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ summary: "New summary" }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(update.titleImages, titleImages);
  assert.equal(update.summary, "New summary");

  // Unauthenticated writes are still refused.
  assert.equal(
    (await fetch(`${base}/blog-add`, { method: "POST" })).status,
    401,
  );
});

test("blog updates stamp updatedAt and integration metadata stays hidden by default", () => {
  assert.equal(AquaBlog.schema.path("integration").options.select, false);
  const hooks = AquaBlog.schema.s.hooks._pres.get("findOneAndUpdate") || [];
  assert.ok(hooks.length > 0);
  const fakeQuery = {
    set: (value) => Object.assign(fakeQuery, { stamped: value }),
  };
  hooks.at(-1).fn.call(fakeQuery);
  assert.ok(fakeQuery.stamped.updatedAt instanceof Date);
});
