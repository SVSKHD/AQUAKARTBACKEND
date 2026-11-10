import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import express from "express";
import jwt from "jsonwebtoken";
import cloudinary from "cloudinary";
import categoryRoutes from "../src/routes/category.js";
import AquaCategory from "../src/models/category.js";
import AquaSubCategory from "../src/models/sub-category.js";
import AquaProduct from "../src/models/product.js";
import AquaBlog from "../src/models/blog.js";
import AquaAdminUser from "../src/models/crm/adminUser.js";
import { jsonErrorHandler } from "../src/middleware/jsonErrors.js";
import {
  assertImageDataUri,
  settleMediaCleanup,
} from "../src/utils/catalogPhotos.js";

// PUT /v1/category-update/:id with real images: a ~2 MiB 1254x1254 PNG (with
// and without metadata chunks), JPEG and WebP, as JSON data URIs (what the
// CRM sends) and as multipart files with keepPhotos. Cloudinary failures use
// the SDK's real rejection shape ({ message, http_code }). Models and
// Cloudinary are mocked: nothing reaches MongoDB or Cloudinary.

const OWN = "https://res.cloudinary.com/aquakartproducts/image/upload";
const CAT_ID = "6528debce9e8a06a49a23b2c";
const EXISTING = {
  id: "categories/keep",
  secure_url: `${OWN}/v1/categories/keep.jpg`,
};

// ── Fixtures ───────────────────────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
};
// A structurally valid RGB PNG (correct CRCs, zlib IDAT).
const makePng = ({ size = 1254, noise = 0.2, metadata = false } = {}) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(size * stride);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size * 3; x += 1)
      raw[y * stride + 1 + x] =
        rand() < noise ? Math.floor(rand() * 256) : (x + y) & 0xff;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    ...(metadata
      ? [
          pngChunk("tEXt", Buffer.from("Software\0Aquakart fixture")),
          pngChunk("pHYs", Buffer.from("00000b1300000b1301", "hex")),
          pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x/>")),
        ]
      : []),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};
const PNG_WITH_METADATA = makePng({ metadata: true });
const PNG_STRIPPED = makePng({ metadata: false });
const JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300" +
    "08".repeat(64) +
    "ffd9",
  "hex",
);
const webpBody = Buffer.concat([
  Buffer.from("WEBPVP8 ", "latin1"),
  Buffer.from("0a0000003001009d012a0100010000", "hex"),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([
    webpBody.length & 0xff,
    (webpBody.length >> 8) & 0xff,
    (webpBody.length >> 16) & 0xff,
    0,
  ]),
  webpBody,
]);
const dataUri = (type, buffer) =>
  `data:image/${type};base64,${buffer.toString("base64")}`;

// ── App ────────────────────────────────────────────────────────────────────
const startApp = async (t) => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-images";
  cloudinary.v2.config({ cloud_name: "aquakartproducts" });
  const app = express();
  app.use(express.json({ limit: "50mb" })); // as app.js
  app.use("/v1", categoryRoutes);
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.mock.method(AquaAdminUser, "findById", () => ({
    populate: async () => ({ _id: "admin", role: 1, status: "active" }),
  }));
  for (const Model of [AquaCategory, AquaSubCategory, AquaProduct, AquaBlog])
    t.mock.method(Model, "exists", async () => null);
  t.mock.method(AquaCategory, "findById", async () => ({
    _id: CAT_ID,
    title: "Softeners",
    photos: [EXISTING],
  }));
  const db = { writes: [], fail: null };
  t.mock.method(AquaCategory, "findByIdAndUpdate", async (id, set) => {
    if (db.fail) throw db.fail;
    db.writes.push(set);
    return { _id: id, title: "Softeners", ...set };
  });
  const token = jwt.sign(
    { _id: "64b0000000000000000000aa" },
    process.env.JWT_SECRET,
  );
  const put = (body) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/v1/category-update/${CAT_ID}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
        },
        body: body instanceof FormData ? body : JSON.stringify(body),
      },
    );
  return { put, db };
};

// failAt: 1-based upload number that fails with the given rejection.
const mockCloudinary = (t, { failAt, rejection } = {}) => {
  const uploads = [];
  const destroyed = [];
  let n = 0;
  const next = () => {
    n += 1;
    if (n === failAt) return { error: rejection };
    return {
      result: {
        public_id: `categories/new_${n}`,
        secure_url: `${OWN}/v2/categories/new_${n}.png`,
      },
    };
  };
  t.mock.method(cloudinary.v2.uploader, "upload", async (value, options) => {
    uploads.push({ kind: "data-uri", head: value.slice(0, 22), options });
    const { error, result } = next();
    if (error) throw error;
    return result;
  });
  t.mock.method(cloudinary.v2.uploader, "upload_stream", (options, done) => ({
    end: (buffer) => {
      uploads.push({ kind: "file", bytes: buffer.length, options });
      const { error, result } = next();
      done(error, result);
    },
  }));
  t.mock.method(cloudinary.v2.uploader, "destroy", async (id) => {
    destroyed.push(id);
    return { result: "ok" };
  });
  return { uploads, destroyed };
};

test("fixtures: a ~2 MiB 1254x1254 PNG, with and without metadata, passes the image check", () => {
  for (const png of [PNG_WITH_METADATA, PNG_STRIPPED]) {
    assert.ok(
      png.length > 1.5 * 1048576 && png.length < 2.6 * 1048576,
      `${png.length} bytes`,
    );
    assert.equal(png.readUInt32BE(16), 1254);
    assert.equal(assertImageDataUri(dataUri("png", png)), "png");
  }
  assert.ok(PNG_WITH_METADATA.length > PNG_STRIPPED.length);
  assert.equal(assertImageDataUri(dataUri("jpeg", JPEG)), "jpeg");
  assert.equal(assertImageDataUri(dataUri("webp", WEBP)), "webp");
});

test("CRM JSON update with a ~2 MiB PNG data URI uploads once and keeps existing photos", async (t) => {
  for (const png of [PNG_WITH_METADATA, PNG_STRIPPED]) {
    const { put, db } = await startApp(t);
    const { uploads, destroyed } = mockCloudinary(t);
    const response = await put({
      title: "Softeners",
      photos: [
        EXISTING,
        { id: "crm-random-id", secure_url: dataUri("png", png) },
      ],
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(
      data.photos.map((photo) => photo.id),
      ["categories/keep", "categories/new_1"],
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].head, "data:image/png;base64,");
    assert.deepEqual(uploads[0].options, {
      folder: "categories",
      resource_type: "image",
    });
    assert.equal(db.writes.length, 1);
    await settleMediaCleanup();
    assert.deepEqual(destroyed, [], "the existing photo is not deleted");
    t.mock.restoreAll();
  }
});

test("JPEG and WebP data URIs upload the same way", async (t) => {
  const { put } = await startApp(t);
  const { uploads } = mockCloudinary(t);
  const response = await put({
    photos: [
      EXISTING,
      { id: "a", secure_url: dataUri("jpeg", JPEG) },
      { id: "b", secure_url: dataUri("webp", WEBP) },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    uploads.map((upload) => upload.head),
    ["data:image/jpeg;base64", "data:image/webp;base64"],
  );
});

test("multipart PNG/JPEG/WebP files with keepPhotos add to the existing photos (no base64 in JSON)", async (t) => {
  const { put, db } = await startApp(t);
  const { uploads, destroyed } = mockCloudinary(t);
  const form = new FormData();
  form.append("title", "Softeners");
  form.append("keepPhotos", JSON.stringify([EXISTING]));
  form.append(
    "photos",
    new Blob([PNG_STRIPPED], { type: "image/png" }),
    "a.png",
  );
  form.append("photos", new Blob([JPEG], { type: "image/jpeg" }), "b.jpg");
  form.append("photos", new Blob([WEBP], { type: "image/webp" }), "c.webp");
  const response = await put(form);
  assert.equal(response.status, 200);
  assert.deepEqual(
    db.writes[0].photos.map((photo) => photo.id),
    [
      "categories/keep",
      "categories/new_1",
      "categories/new_2",
      "categories/new_3",
    ],
  );
  assert.deepEqual(
    uploads.map((upload) => upload.kind),
    ["file", "file", "file"],
  );
  assert.equal(uploads[0].bytes, PNG_STRIPPED.length);
  await settleMediaCleanup();
  assert.deepEqual(destroyed, []);

  const bad = new FormData();
  bad.append("keepPhotos", "not json");
  bad.append("photos", new Blob([JPEG], { type: "image/jpeg" }), "b.jpg");
  const invalid = await put(bad);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_FIELD");
});

const cloudinaryFailures = [
  {
    name: "Cloudinary size limit",
    rejection: {
      message: "File size too large. Got 2097152. Maximum is 1048576.",
      http_code: 400,
    },
    status: 413,
    code: "IMAGE_TOO_LARGE_FOR_CLOUDINARY",
  },
  {
    name: "Cloudinary rejects the image",
    rejection: { message: "Invalid image file", http_code: 400 },
    status: 400,
    code: "IMAGE_REJECTED_BY_CLOUDINARY",
  },
  {
    name: "Cloudinary timeout",
    rejection: {
      message: "Request Timeout",
      http_code: 499,
      name: "TimeoutError",
    },
    status: 502,
    code: "CLOUDINARY_TIMEOUT",
  },
  {
    name: "Cloudinary auth/config error",
    rejection: {
      message:
        "Invalid Signature 0123abcd. String to sign - 'folder=categories&timestamp=1'.",
      http_code: 401,
    },
    status: 502,
    code: "CLOUDINARY_UPLOAD_FAILED",
    hidden: "Signature",
  },
];

for (const failure of cloudinaryFailures) {
  test(`failed Cloudinary upload (${failure.name}) → ${failure.status} ${failure.code}; nothing saved, earlier uploads removed`, async (t) => {
    const { put, db } = await startApp(t);
    const { destroyed } = mockCloudinary(t, {
      failAt: 2,
      rejection: failure.rejection,
    });
    t.mock.method(console, "error", () => {});
    const response = await put({
      photos: [
        EXISTING,
        { id: "a", secure_url: dataUri("png", PNG_STRIPPED) },
        { id: "b", secure_url: dataUri("jpeg", JPEG) },
      ],
    });
    assert.equal(response.status, failure.status);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.code, failure.code);
    assert.equal(body.stage, "cloudinary_upload");
    assert.equal(body.photoIndex, 2, "the JPEG (third entry) failed");
    if (failure.hidden)
      assert.ok(!JSON.stringify(body).includes(failure.hidden));
    assert.equal(db.writes.length, 0, "the category is not changed");
    await settleMediaCleanup();
    assert.deepEqual(
      destroyed,
      ["categories/new_1"],
      "only the new upload is removed",
    );
  });
}

test("a failed multipart upload is a 502 with the failing file's index", async (t) => {
  const { put, db } = await startApp(t);
  mockCloudinary(t, {
    failAt: 1,
    rejection: { message: "Server Error", http_code: 500 },
  });
  t.mock.method(console, "error", () => {});
  const form = new FormData();
  form.append("keepPhotos", JSON.stringify([EXISTING]));
  form.append("photos", new Blob([WEBP], { type: "image/webp" }), "c.webp");
  const response = await put(form);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, "CLOUDINARY_UPLOAD_FAILED");
  assert.equal(body.photoIndex, 1);
  assert.equal(db.writes.length, 0);
});

test("a database failure is a 500 DATABASE_ERROR; the new upload is removed, existing photos kept", async (t) => {
  const { put, db } = await startApp(t);
  const { destroyed } = mockCloudinary(t);
  t.mock.method(console, "error", () => {});
  db.fail = Object.assign(new Error("connection reset by peer"), {
    name: "MongoNetworkError",
  });
  const response = await put({
    photos: [EXISTING, { id: "a", secure_url: dataUri("png", PNG_STRIPPED) }],
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "DATABASE_ERROR");
  assert.equal(body.stage, "database");
  assert.ok(!JSON.stringify(body).includes("connection reset"));
  await settleMediaCleanup();
  assert.deepEqual(destroyed, ["categories/new_1"]);
});

test("validation failures are 400/413 with codes and no upload", async (t) => {
  const { put } = await startApp(t);
  const { uploads } = mockCloudinary(t);
  const fake = await put({
    photos: [{ id: "x", secure_url: dataUri("png", Buffer.from("<?php ?>")) }],
  });
  assert.equal(fake.status, 400);
  assert.equal((await fake.json()).code, "INVALID_PHOTO");
  const before = process.env.CATALOG_MAX_IMAGE_BYTES;
  process.env.CATALOG_MAX_IMAGE_BYTES = String(1024 * 1024);
  t.after(() => {
    if (before === undefined) delete process.env.CATALOG_MAX_IMAGE_BYTES;
    else process.env.CATALOG_MAX_IMAGE_BYTES = before;
  });
  const big = await put({
    photos: [{ id: "x", secure_url: dataUri("png", PNG_STRIPPED) }],
  });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).code, "IMAGE_TOO_LARGE");
  assert.equal(uploads.length, 0);
});
