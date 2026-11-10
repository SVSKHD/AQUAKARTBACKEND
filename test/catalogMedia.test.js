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
import AquaBlog from "../src/models/blog.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";
import { jsonErrorHandler } from "../src/middleware/jsonErrors.js";
import {
  assertImageBuffer,
  assertImageDataUri,
  cloudinaryResourceType,
  settleMediaCleanup,
} from "../src/utils/catalogPhotos.js";

// Catalog media safety: input checks, JSON errors for oversized bodies,
// cleanup of failed uploads, and reference-safe deletes. Models and
// Cloudinary are mocked; nothing reaches MongoDB or Cloudinary.

const OWN = "https://res.cloudinary.com/aquakartproducts";
const CAT_ID = "6528debce9e8a06a49a23b2c";
const SUB_ID = "6acd88dbabf4d4bcba7e1cf3";
const PRODUCT_ID = "64b000000000000000000001";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;
const HEIC = Buffer.from("000000186674797068656963000000006d696631", "hex");
// Claims to be a PNG but is a script.
const NOT_IMAGE_URI = `data:image/png;base64,${Buffer.from(
  "<?php system($_GET[c]); ?>",
).toString("base64")}`;

const startApp = async (t, { jsonLimit = "5mb" } = {}) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-media";
  cloudinary.v2.config({ cloud_name: "aquakartproducts" });
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  app.use("/v1", categoryRoutes);
  app.use("/v1", subCategoryRoutes);
  app.use("/v1", productRoutes);
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adminId = "64b0000000000000000000aa";
  t.mock.method(AquaAdminUser, "findById", () => ({
    populate: async () => ({ _id: adminId, role: 1, status: "active" }),
  }));
  // Nothing references anything unless a test says otherwise.
  const references = new Set();
  for (const Model of [AquaCategory, AquaSubCategory, AquaProduct, AquaBlog])
    t.mock.method(Model, "exists", async (filter) => {
      const ids = (filter.$or || []).flatMap(Object.values);
      return ids.some((id) => references.has(id)) ? { _id: "x" } : null;
    });
  const token = jwt.sign({ _id: adminId }, process.env.JWT_SECRET);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = (method, path, body, headers = {}) =>
    fetch(`${base}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(typeof body === "string" || body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
        ...headers,
      },
      body:
        body === undefined ||
        typeof body === "string" ||
        body instanceof FormData
          ? body
          : JSON.stringify(body),
    });
  return { call, references };
};

// Sets CATALOG_MAX_IMAGE_BYTES for one test and restores it afterwards.
const setImageLimit = (t, value) => {
  const before = process.env.CATALOG_MAX_IMAGE_BYTES;
  if (value === undefined) delete process.env.CATALOG_MAX_IMAGE_BYTES;
  else process.env.CATALOG_MAX_IMAGE_BYTES = value;
  t.after(() => {
    if (before === undefined) delete process.env.CATALOG_MAX_IMAGE_BYTES;
    else process.env.CATALOG_MAX_IMAGE_BYTES = before;
  });
};

const mockCloudinary = (t, { failDestroyOnce = false } = {}) => {
  const uploads = [];
  const destroyed = [];
  let n = 0;
  let failed = false;
  t.mock.method(cloudinary.v2.uploader, "upload", async (value, options) => {
    n += 1;
    uploads.push(value);
    return {
      public_id: `${options.folder}/new_${n}`,
      secure_url: `${OWN}/image/upload/v2/${options.folder}/new_${n}.png`,
    };
  });
  t.mock.method(cloudinary.v2.uploader, "upload_stream", (options, done) => ({
    end: () => {
      n += 1;
      uploads.push("stream");
      done(null, {
        public_id: `${options.folder}/file_${n}`,
        secure_url: `${OWN}/image/upload/v2/${options.folder}/file_${n}.png`,
      });
    },
  }));
  t.mock.method(cloudinary.v2.uploader, "destroy", async (id, options) => {
    if (failDestroyOnce && !failed) {
      failed = true;
      throw new Error("temporary Cloudinary error");
    }
    destroyed.push({ id, resource_type: options?.resource_type });
    return { result: "ok" };
  });
  return { uploads, destroyed };
};

test("image checks: type by magic bytes, size limit, no SVG", (t) => {
  assert.equal(assertImageDataUri(PNG_URI), "png");
  assert.equal(assertImageBuffer(JPEG, "image/jpeg"), "jpeg");
  const status = (fn) => {
    try {
      fn();
      return 200;
    } catch (error) {
      return error.statusCode;
    }
  };
  // A real but mislabelled image is accepted (Cloudinary reads content), as
  // is a file the browser sent as application/octet-stream, and HEIC.
  assert.equal(
    assertImageDataUri(`data:image/png;base64,${JPEG.toString("base64")}`),
    "jpeg",
  );
  assert.equal(assertImageBuffer(PNG, "application/octet-stream"), "png");
  assert.equal(assertImageBuffer(HEIC, "image/heic"), "heic");
  // Not an image at all, whatever it claims to be.
  assert.equal(
    status(() =>
      assertImageBuffer(Buffer.from("<?php echo 1; ?>"), "image/png"),
    ),
    400,
  );
  assert.equal(
    status(() => assertImageDataUri(NOT_IMAGE_URI)),
    400,
  );
  assert.equal(
    status(() => assertImageBuffer(Buffer.from("<svg/>"), "image/svg+xml")),
    400,
  );
  assert.equal(
    status(() =>
      assertImageDataUri(
        `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
      ),
    ),
    400,
  );
  setImageLimit(t, "8");
  assert.equal(
    status(() => assertImageDataUri(PNG_URI)),
    413,
  );
  assert.equal(
    status(() => assertImageBuffer(PNG, "image/png")),
    413,
  );
});

test("Cloudinary resource type comes from the URL (destroy rejects 'auto')", () => {
  assert.equal(cloudinaryResourceType(`${OWN}/image/upload/v1/a.png`), "image");
  assert.equal(cloudinaryResourceType(`${OWN}/raw/upload/v1/a.glb`), "raw");
  assert.equal(cloudinaryResourceType(`${OWN}/video/upload/v1/a.mp4`), "video");
  assert.equal(cloudinaryResourceType("https://cdn.example.com/a.png"), null);
});

test("oversized and malformed bodies get JSON errors, not Express HTML", async (t) => {
  const { call } = await startApp(t, { jsonLimit: "1kb" });
  const big = await call("PUT", `category-update/${CAT_ID}`, {
    photos: [
      { id: "x", secure_url: `data:image/png;base64,${"A".repeat(4000)}` },
    ],
  });
  assert.equal(big.status, 413);
  assert.match(big.headers.get("content-type"), /json/);
  assert.equal((await big.json()).success, false);

  const bad = await call("PUT", `category-update/${CAT_ID}`, "{not json", {
    "content-type": "application/json",
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), {
    success: false,
    message: "Invalid request body",
  });
});

test("a multipart file over the route limit is a JSON 413 (was an HTML 500)", async (t) => {
  const { call } = await startApp(t);
  const { uploads } = mockCloudinary(t);
  const form = new FormData();
  form.append("title", "Water Heaters");
  form.append(
    "photos",
    new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], { type: "image/png" }),
    "huge.png",
  );
  const response = await call("POST", "category-add", form);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).success, false);
  assert.equal(uploads.length, 0);
});

test("an oversized or fake data-URI photo is refused before any upload", async (t) => {
  const { call } = await startApp(t);
  const { uploads } = mockCloudinary(t);
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
    photos: [],
  }));
  setImageLimit(t, "8");
  const tooBig = await call("PUT", `category-update/${CAT_ID}`, {
    photos: [{ id: "n", secure_url: PNG_URI }],
  });
  assert.equal(tooBig.status, 413);
  delete process.env.CATALOG_MAX_IMAGE_BYTES; // restored by the earlier setImageLimit
  const fake = await call("PUT", `category-update/${CAT_ID}`, {
    photos: [
      { id: "n", secure_url: PNG_URI },
      {
        id: "m",
        secure_url: NOT_IMAGE_URI,
      },
    ],
  });
  assert.equal(fake.status, 400);
  assert.equal(uploads.length, 0, "nothing uploaded when any photo is invalid");
});

test("a failed category write removes the new uploads and hides the internal error", async (t) => {
  const { call } = await startApp(t);
  const { uploads, destroyed } = mockCloudinary(t);
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
    photos: [],
  }));
  t.mock.method(AquaCategory, "findByIdAndUpdate", async () => {
    throw new Error("E11000 secret internal detail");
  });
  const response = await call("PUT", `category-update/${CAT_ID}`, {
    photos: [{ id: "n", secure_url: PNG_URI }],
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes("secret"));
  assert.equal(uploads.length, 1);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, [
    { id: "categories/new_1", resource_type: "image" },
  ]);
});

test("removed photos still used by another record are not deleted; cleanup retries once", async (t) => {
  const { call, references } = await startApp(t);
  const { destroyed } = mockCloudinary(t, { failDestroyOnce: true });
  const shared = {
    id: "Blogs/shared",
    secure_url: `${OWN}/image/upload/v1/Blogs/shared.png`,
  };
  const own = {
    id: "categories/old",
    secure_url: `${OWN}/image/upload/v1/categories/old.png`,
  };
  const keep = {
    id: "categories/keep",
    secure_url: `${OWN}/image/upload/v1/categories/keep.png`,
  };
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
    photos: [shared, own, keep],
  }));
  t.mock.method(AquaCategory, "findByIdAndUpdate", async (id, set) => ({
    _id: id,
    ...set,
  }));
  references.add("Blogs/shared"); // a blog title image uses it
  const response = await call("PUT", `category-update/${CAT_ID}`, {
    photos: [keep],
  });
  assert.equal(response.status, 200);
  await settleMediaCleanup();
  // First destroy attempt failed and was retried; the shared image stayed.
  assert.deepEqual(destroyed, [
    { id: "categories/old", resource_type: "image" },
  ]);
});

test("deleting a category removes its unused photos after the record is deleted", async (t) => {
  const { call } = await startApp(t);
  const { destroyed } = mockCloudinary(t);
  const photo = {
    id: "categories/a",
    secure_url: `${OWN}/image/upload/v1/categories/a.png`,
  };
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
    photos: [photo],
  }));
  t.mock.method(AquaSubCategory, "countDocuments", async () => 0);
  t.mock.method(AquaProduct, "countDocuments", async () => 0);
  t.mock.method(AquaCategory, "findByIdAndDelete", async () => {
    throw new Error("db down");
  });
  assert.equal((await call("DELETE", `category-delete/${CAT_ID}`)).status, 500);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, [], "a failed delete keeps the photos");

  t.mock.method(AquaCategory, "findByIdAndDelete", async () => ({
    _id: CAT_ID,
  }));
  assert.equal((await call("DELETE", `category-delete/${CAT_ID}`)).status, 200);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, [{ id: "categories/a", resource_type: "image" }]);
});

test("duplicate titles are a 409; re-saving a record with its own title is not", async (t) => {
  const { call } = await startApp(t);
  mockCloudinary(t);
  t.mock.method(AquaCategory, "exists", async (filter) =>
    filter.title instanceof RegExp && filter.title.test(" softeners ")
      ? { _id: "other" }
      : filter._id
        ? { _id: CAT_ID }
        : null,
  );
  t.mock.method(AquaSubCategory, "exists", async (filter) =>
    filter.title?.test?.("automatic softeners") ? { _id: "other" } : null,
  );
  assert.equal(
    (
      await call("POST", "category-add", {
        title: "SOFTENERS",
        photos: [{ id: "n", secure_url: PNG_URI }],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("POST", "subcategory-add", {
        category: CAT_ID,
        title: "Automatic Softeners",
      })
    ).status,
    409,
  );
  // Same title (case change only) on its own record: allowed.
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
    photos: [],
  }));
  t.mock.method(AquaCategory, "findByIdAndUpdate", async (id, set) => ({
    _id: id,
    ...set,
  }));
  assert.equal(
    (await call("PUT", `category-update/${CAT_ID}`, { title: "softeners" }))
      .status,
    200,
  );
});

test("subcategory: clearPhotos removes all photos; failed writes clean up uploads", async (t) => {
  const { call } = await startApp(t);
  const { destroyed } = mockCloudinary(t);
  const photo = {
    id: "subcategories/a",
    secure_url: `${OWN}/image/upload/v1/subcategories/a.png`,
  };
  t.mock.method(AquaSubCategory, "findById", async () => ({
    _id: SUB_ID,
    title: "Automatic",
    category: CAT_ID,
    photos: [photo],
  }));
  // Parent category exists; nothing else uses the photo.
  t.mock.method(AquaCategory, "exists", async (filter) =>
    filter._id ? { _id: CAT_ID } : null,
  );
  let changes;
  t.mock.method(AquaSubCategory, "findByIdAndUpdate", (id, set) => {
    changes = set;
    return { populate: async () => ({ _id: id, ...set }) };
  });
  // [] still keeps the photos (CRM contract).
  assert.equal(
    (await call("PUT", `subcategory-update/${SUB_ID}`, { photos: [] })).status,
    200,
  );
  assert.equal(changes.photos, undefined);
  assert.equal(
    (
      await call("PUT", `subcategory-update/${SUB_ID}`, {
        clearPhotos: true,
        photos: [photo],
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("PUT", `subcategory-update/${SUB_ID}`, { clearPhotos: true }))
      .status,
    200,
  );
  assert.deepEqual(changes.photos, []);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, [
    { id: "subcategories/a", resource_type: "image" },
  ]);

  destroyed.length = 0;
  t.mock.method(AquaSubCategory, "findByIdAndUpdate", () => ({
    populate: async () => {
      throw new Error("db down");
    },
  }));
  const failed = await call("PUT", `subcategory-update/${SUB_ID}`, {
    photos: [photo, { id: "n", secure_url: PNG_URI }],
  });
  assert.equal(failed.status, 500);
  await settleMediaCleanup();
  assert.deepEqual(
    destroyed.map((d) => d.id),
    ["subcategories/new_1"],
  );
});

test("product delete: media removed only after the DB delete, with the right resource type", async (t) => {
  const { call } = await startApp(t);
  const { destroyed } = mockCloudinary(t);
  const events = [];
  t.mock.method(AquaProduct, "findById", async () => ({
    _id: PRODUCT_ID,
    photos: [
      { id: "products/a", secure_url: `${OWN}/image/upload/v1/products/a.png` },
      { id: "external_1", secure_url: "https://cdn.example.com/a.png" },
    ],
    arPhotos: [
      {
        id: "ar_products/m.glb",
        secure_url: `${OWN}/raw/upload/v1/ar_products/m.glb`,
      },
    ],
  }));
  t.mock.method(AquaProduct, "findByIdAndDelete", async () => {
    events.push("db-delete");
    return { _id: PRODUCT_ID };
  });
  const response = await call("DELETE", `product/${PRODUCT_ID}`);
  assert.equal(response.status, 200);
  await settleMediaCleanup();
  assert.equal(events[0], "db-delete");
  assert.deepEqual(destroyed, [
    { id: "products/a", resource_type: "image" },
    { id: "ar_products/m.glb", resource_type: "raw" },
  ]);
});

test("product update: failed write cleans up uploads; a vanished product is a 404", async (t) => {
  const { call } = await startApp(t);
  const { destroyed } = mockCloudinary(t);
  t.mock.method(AquaProduct, "findById", async () => ({
    _id: PRODUCT_ID,
    title: "Softener",
    photos: [],
    arPhotos: [],
  }));
  t.mock.method(AquaProduct, "findByIdAndUpdate", async () => null);
  const gone = await call("PUT", `product-update/${PRODUCT_ID}`, {
    photos: [{ id: "n", secure_url: PNG_URI }],
  });
  assert.equal(gone.status, 404);
  await settleMediaCleanup();
  assert.deepEqual(
    destroyed.map((d) => d.id),
    ["products/new_1"],
  );

  destroyed.length = 0;
  t.mock.method(AquaProduct, "findByIdAndUpdate", async () => {
    throw new Error("db down");
  });
  const failed = await call("PUT", `product-update/${PRODUCT_ID}`, {
    photos: [{ id: "n", secure_url: PNG_URI }],
  });
  assert.equal(failed.status, 500);
  await settleMediaCleanup();
  assert.equal(destroyed.length, 1);

  const fake = await call("PUT", `product-update/${PRODUCT_ID}`, {
    photos: [NOT_IMAGE_URI],
  });
  assert.equal(fake.status, 400);
});
