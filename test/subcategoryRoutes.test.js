import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import cloudinary from "cloudinary";
import subCategoryRoutes from "../src/routes/sub-category.js";
import { publicIdFromUrl } from "../src/controllers/sub-category.js";
import AquaSubCategory from "../src/models/sub-category.js";
import AquaCategory from "../src/models/category.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";

// The CRM updates subcategories with PUT /v1/subcategory-update/:id; the
// legacy POST with the id in the body keeps working. Models are mocked.

const SUB_ID = "6acd88dbabf4d4bcba7e1cf3";
const CATEGORY_ID = "6528debce9e8a06a49a23b2c";

const startApp = async (t) => {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "test-secret-for-subcategory-routes";
  const app = express();
  app.use(express.json());
  app.use("/v1", subCategoryRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
};

const mockModels = (t) => {
  const adminId = "64b0000000000000000000aa";
  t.mock.method(AquaAdminUser, "findById", () => ({
    populate: async () => ({ _id: adminId, role: 1, status: "active" }),
  }));
  t.mock.method(AquaSubCategory, "findById", async (id) =>
    id === SUB_ID ? { _id: SUB_ID, title: "Old", category: CATEGORY_ID } : null,
  );
  t.mock.method(AquaCategory, "exists", async ({ _id }) =>
    _id === CATEGORY_ID ? { _id } : null,
  );
  // Duplicate-title check: no other subcategory has the title.
  t.mock.method(AquaSubCategory, "exists", async () => null);
  const updates = [];
  t.mock.method(AquaSubCategory, "findByIdAndUpdate", (id, data) => {
    updates.push({ id, data });
    return {
      populate: async () => ({
        _id: id,
        ...data,
        category: { _id: CATEGORY_ID, title: "Softeners" },
      }),
    };
  });
  return { token: jwt.sign({ _id: adminId }, process.env.JWT_SECRET), updates };
};

const crmBody = {
  category_id: CATEGORY_ID,
  title: "Automatic Softeners",
  description: "Automatic water softeners remove hardness from water.",
  keywords: "automatic water softener Hyderabad, Kent automatic water softener",
  photos: [],
  category: CATEGORY_ID,
};

test("PUT /subcategory-update/:id (the CRM call) updates the subcategory", async (t) => {
  const base = await startApp(t);
  const { token, updates } = mockModels(t);
  const response = await fetch(`${base}/subcategory-update/${SUB_ID}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(crmBody),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.title, "Automatic Softeners");
  assert.equal(updates[0].id, SUB_ID);
  assert.equal(updates[0].data.category, CATEGORY_ID);
  assert.equal(updates[0].data.keywords, crmBody.keywords);
  // photos: [] keeps the existing photos.
  assert.equal("photos" in updates[0].data, false);
});

test("legacy POST /subcategory-update with the id in the body still works", async (t) => {
  const base = await startApp(t);
  const { token, updates } = mockModels(t);
  const response = await fetch(`${base}/subcategory-update`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: SUB_ID, title: "Manual Softeners" }),
  });
  assert.equal(response.status, 200);
  assert.equal(updates[0].id, SUB_ID);
});

test("subcategory updates still need an admin token and a valid id", async (t) => {
  const base = await startApp(t);
  const { token } = mockModels(t);
  assert.equal(
    (
      await fetch(`${base}/subcategory-update/${SUB_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  assert.equal(
    (
      await fetch(`${base}/subcategory-update/not-an-id`, {
        method: "PUT",
        headers,
        body: "{}",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/subcategory-update/64b0000000000000000000ff`, {
        method: "PUT",
        headers,
        body: "{}",
      })
    ).status,
    404,
  );
});

const OWN = "https://res.cloudinary.com/aquakartproducts/image/upload";

test("photo public ids are derived from Cloudinary URLs, ignoring transformations", () => {
  assert.equal(
    publicIdFromUrl(`${OWN}/v1700000000/subcategories/auto_soft.jpg`),
    "subcategories/auto_soft",
  );
  assert.equal(
    publicIdFromUrl(`${OWN}/w_400,c_fill/v17/subcategories/a.png`),
    "subcategories/a",
  );
  assert.equal(
    publicIdFromUrl(`${OWN}/subcategories/b.webp`),
    "subcategories/b",
  );
});

test("updates keep existing photos, keep own Cloudinary URLs and upload only new images", async (t) => {
  cloudinary.v2.config({ cloud_name: "aquakartproducts" });
  const base = await startApp(t);
  const { token, updates } = mockModels(t);
  const uploads = [];
  t.mock.method(cloudinary.v2.uploader, "upload", async (value, options) => {
    uploads.push({ value, options });
    return {
      public_id: "subcategories/new_one",
      secure_url: `${OWN}/v2/subcategories/new_one.png`,
    };
  });
  const existing = {
    id: "subcategories/kept",
    secure_url: `${OWN}/v1/subcategories/kept.jpg`,
  };
  const response = await fetch(`${base}/subcategory-update/${SUB_ID}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...crmBody,
      photos: [
        existing,
        `${OWN}/v9/subcategories/from_url.jpg`,
        "data:image/png;base64,iVBORw0KGgo=",
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(updates[0].data.photos, [
    existing,
    {
      id: "subcategories/from_url",
      secure_url: `${OWN}/v9/subcategories/from_url.jpg`,
    },
    {
      id: "subcategories/new_one",
      secure_url: `${OWN}/v2/subcategories/new_one.png`,
    },
  ]);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].value, /^data:image\/png/);
  assert.equal(uploads[0].options.folder, "subcategories");
});

test("invalid photo entries are a 400, not a server error", async (t) => {
  const base = await startApp(t);
  const { token, updates } = mockModels(t);
  t.mock.method(cloudinary.v2.uploader, "upload", async () => {
    throw new Error("should not upload");
  });
  for (const photos of [
    [{ foo: "bar" }],
    ["not a url"],
    "data:image/png;base64,xx",
  ]) {
    const response = await fetch(`${base}/subcategory-update/${SUB_ID}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Automatic Softeners", photos }),
    });
    assert.equal(response.status, 400, JSON.stringify(photos));
  }
  assert.equal(updates.length, 0);
});
