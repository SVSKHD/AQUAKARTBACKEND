import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import cloudinary from "cloudinary";
import categoryRoutes from "../src/routes/category.js";
import subCategoryRoutes from "../src/routes/sub-category.js";
import productRoutes from "../src/routes/product.js";
import AquaCategory from "../src/models/category.js";
import AquaSubCategory from "../src/models/sub-category.js";
import AquaProduct from "../src/models/product.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";
import AquaBlog from "../src/models/blog.js";
import {
  publicIdFromUrl,
  removedPhotos,
  resolveCatalogPhotos,
  settleMediaCleanup,
} from "../src/utils/catalogPhotos.js";

// The CRM (AQUACRM25DEV, src/services/apiService.ts + ProductsTab.tsx) sends
// JSON bodies; photos are always { id, secure_url } where new picks carry a
// random id and a data: URI. These tests replay those exact shapes against
// the backend routes with models and Cloudinary mocked.

const OWN = "https://res.cloudinary.com/aquakartproducts/image/upload";
const CAT_ID = "6528debce9e8a06a49a23b2c";
const SUB_ID = "6acd88dbabf4d4bcba7e1cf3";
const PRODUCT_ID = "64b0000000000000000000p1".replace("p", "0");
const DATA = "data:image/png;base64,iVBORw0KGgo=";

const startApp = async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-catalog";
  cloudinary.v2.config({ cloud_name: "aquakartproducts" });
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/v1", categoryRoutes);
  app.use("/v1", subCategoryRoutes);
  app.use("/v1", productRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adminId = "64b0000000000000000000aa";
  t.mock.method(AquaAdminUser, "findById", () => ({
    populate: async () => ({ _id: adminId, role: 1, status: "active" }),
  }));
  // Duplicate-title and image-in-use checks: nothing found unless a test
  // mocks exists() again.
  for (const Model of [AquaCategory, AquaSubCategory, AquaProduct, AquaBlog])
    t.mock.method(Model, "exists", async () => null);
  const token = jwt.sign({ _id: adminId }, process.env.JWT_SECRET);
  const call = (method, path, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call };
};

const mockCloudinary = (t) => {
  const uploads = [];
  const destroyed = [];
  let n = 0;
  t.mock.method(cloudinary.v2.uploader, "upload", async (value, options) => {
    n += 1;
    uploads.push({ value, folder: options.folder });
    return {
      public_id: `${options.folder}/new_${n}`,
      secure_url: `${OWN}/v2/${options.folder}/new_${n}.png`,
    };
  });
  t.mock.method(cloudinary.v2.uploader, "destroy", async (id) => {
    destroyed.push(id);
    return { result: "ok" };
  });
  return { uploads, destroyed };
};

test("photo rules: data URIs upload, own URLs keep their real id, removals are exact", async () => {
  const uploads = [];
  const upload = async (value, options) => {
    uploads.push(value);
    return {
      public_id: `${options.folder}/x`,
      secure_url: `${OWN}/v1/${options.folder}/x.png`,
    };
  };
  const result = await resolveCatalogPhotos(
    [
      { id: "k3j2h1g0f", secure_url: DATA }, // CRM new pick: random id + data URI
      { id: "0.123", secure_url: `${OWN}/v5/categories/real_id.jpg` }, // made-up id
      { id: "ext1", secure_url: "https://cdn.example.com/a.jpg" }, // foreign, kept
    ],
    { folder: "categories", upload },
  );
  assert.deepEqual(result, [
    { id: "categories/x", secure_url: `${OWN}/v1/categories/x.png` },
    {
      id: "categories/real_id",
      secure_url: `${OWN}/v5/categories/real_id.jpg`,
    },
    { id: "ext1", secure_url: "https://cdn.example.com/a.jpg" },
  ]);
  assert.equal(uploads.length, 1);
  await assert.rejects(
    resolveCatalogPhotos([{ id: "a" }], { folder: "x", upload }),
    (error) => error.statusCode === 400,
  );
  assert.equal(publicIdFromUrl(`${OWN}/w_1000,c_fill/v1/a/b.png`), "a/b");
  assert.deepEqual(
    removedPhotos(
      [
        { id: "a", secure_url: "u1" },
        { id: "b", secure_url: "u2" },
      ],
      [{ id: "a", secure_url: "u1" }],
    ).map((photo) => photo.id),
    ["b"],
  );
});

test("CRM category create with JSON photos (no multipart) succeeds", async (t) => {
  const { call } = await startApp(t);
  const { uploads } = mockCloudinary(t);
  let saved;
  t.mock.method(AquaCategory.prototype, "save", async function save() {
    saved = this.toObject();
    return this;
  });
  const response = await call("POST", "category-add", {
    title: "Water Heaters",
    description: "Geysers and heat pumps",
    keywords: "geyser, water heater",
    photos: [{ id: "r4nd0m", secure_url: DATA }],
    user_id: "64b0000000000000000000aa",
  });
  assert.equal(response.status, 201);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].folder, "categories");
  assert.deepEqual(
    saved.photos.map(({ id, secure_url }) => ({ id, secure_url })),
    [{ id: "categories/new_1", secure_url: `${OWN}/v2/categories/new_1.png` }],
  );
  // No photos at all is still refused.
  assert.equal(
    (await call("POST", "category-add", { title: "X", photos: [] })).status,
    400,
  );
});

test("CRM category update keeps existing photos, uploads new ones, deletes only removed ones", async (t) => {
  const { call } = await startApp(t);
  const { uploads, destroyed } = mockCloudinary(t);
  const current = {
    _id: CAT_ID,
    title: "Softeners",
    photos: [
      { id: "categories/keep", secure_url: `${OWN}/v1/categories/keep.jpg` },
      { id: "categories/drop", secure_url: `${OWN}/v1/categories/drop.jpg` },
    ],
  };
  t.mock.method(AquaCategory, "findById", async () => current);
  let changes;
  t.mock.method(AquaCategory, "findByIdAndUpdate", async (id, set) => {
    changes = set;
    return { ...current, ...set };
  });
  const response = await call("PUT", `category-update/${CAT_ID}`, {
    title: "Water Softeners",
    photos: [current.photos[0], { id: "zz9", secure_url: DATA }],
  });
  assert.equal(response.status, 200);
  assert.equal(changes.title, "Water Softeners");
  assert.deepEqual(changes.photos, [
    current.photos[0],
    { id: "categories/new_1", secure_url: `${OWN}/v2/categories/new_1.png` },
  ]);
  assert.equal(uploads.length, 1);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, ["categories/drop"]);

  // Text-only edit with the same photo list: nothing uploaded or deleted.
  uploads.length = 0;
  destroyed.length = 0;
  current.photos = [current.photos[0]];
  assert.equal(
    (
      await call("PUT", `category-update/${CAT_ID}`, {
        description: "x",
        photos: current.photos,
      })
    ).status,
    200,
  );
  assert.equal(uploads.length, 0);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, []);
});

test("the delete paths the CRM calls exist and keep the in-use checks", async (t) => {
  const { call } = await startApp(t);
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
  }));
  let subCount = 1;
  t.mock.method(AquaSubCategory, "countDocuments", async () => subCount);
  t.mock.method(AquaProduct, "countDocuments", async () => 0);
  t.mock.method(AquaCategory, "findByIdAndDelete", async () => ({
    _id: CAT_ID,
  }));
  t.mock.method(AquaSubCategory, "findByIdAndDelete", async () => ({
    _id: SUB_ID,
  }));

  assert.equal((await call("DELETE", `category-delete/${CAT_ID}`)).status, 409);
  subCount = 0;
  assert.equal((await call("DELETE", `category-delete/${CAT_ID}`)).status, 200);
  assert.equal((await call("DELETE", `category/delete/${CAT_ID}`)).status, 200);
  assert.equal(
    (await call("DELETE", `subcategory-delete/${SUB_ID}`)).status,
    200,
  );
  assert.equal(
    (await call("DELETE", `subcategory/delete/${SUB_ID}`)).status,
    200,
  );
});

test("CRM subcategory update uploads new data-URI photos even though they carry an id", async (t) => {
  const { call } = await startApp(t);
  const { uploads } = mockCloudinary(t);
  t.mock.method(AquaSubCategory, "findById", async () => ({
    _id: SUB_ID,
    category: CAT_ID,
  }));
  t.mock.method(AquaCategory, "exists", async () => ({ _id: CAT_ID }));
  let changes;
  t.mock.method(AquaSubCategory, "findByIdAndUpdate", (id, set) => {
    changes = set;
    return { populate: async () => ({ _id: id, ...set }) };
  });
  const existing = {
    id: "subcategories/a",
    secure_url: `${OWN}/v1/subcategories/a.jpg`,
  };
  const response = await call("PUT", `subcategory-update/${SUB_ID}`, {
    category_id: CAT_ID,
    category: CAT_ID,
    title: "Automatic Softeners",
    photos: [existing, { id: "x7y8z9", secure_url: DATA }],
  });
  assert.equal(response.status, 200);
  assert.equal(uploads.length, 1);
  assert.deepEqual(changes.photos, [
    existing,
    {
      id: "subcategories/new_1",
      secure_url: `${OWN}/v2/subcategories/new_1.png`,
    },
  ]);
  assert.ok(!JSON.stringify(changes.photos).includes("data:image"));
});

test("CRM product update keeps the photos it sends back and deletes only removed ones", async (t) => {
  const { call } = await startApp(t);
  const { uploads, destroyed } = mockCloudinary(t);
  const photos = [
    { id: "products/keep", secure_url: `${OWN}/v1/products/keep.jpg` },
    { id: "products/drop", secure_url: `${OWN}/v1/products/drop.jpg` },
  ];
  t.mock.method(AquaProduct, "findById", async () => ({
    _id: PRODUCT_ID,
    title: "Softener",
    photos,
    arPhotos: [],
  }));
  let update;
  t.mock.method(AquaProduct, "findByIdAndUpdate", async (id, set) => {
    update = set;
    return { ...set, _id: id, populate: async () => {} };
  });
  const response = await call("PUT", `product-update/${PRODUCT_ID}`, {
    title: "Auto Softener",
    price: 24999,
    photos: [photos[0], { id: "n3w", secure_url: DATA }],
  });
  assert.equal(response.status, 200);
  assert.equal(update.photos.length, 2);
  assert.equal(update.photos[0].id, "products/keep");
  assert.equal(uploads.length, 1);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, ["products/drop"]);
});
