import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  ENCRYPTION_KEY_NAME,
  createAquaEnvStore,
  decryptValue,
  encryptValue,
  isReservedKey,
  maskValue,
  parseEncryptionKey,
} from "../src/services/aquaEnv.js";
import { createAquaEnvController } from "../src/controllers/crm/aquaEnv.js";
import { PERMISSIONS } from "../src/constants/permissions.js";

const HEX_KEY = randomBytes(32).toString("hex");

// Minimal in-memory stand-in for the AquaEnv Mongoose model.
const fakeModel = (initial = []) => {
  const docs = initial.map((d) => ({ ...d }));
  const q = (value) => ({
    lean: async () => structuredClone(value),
    sort: () =>
      q(value && [...value].sort((a, b) => a.key.localeCompare(b.key))),
    select: () => q(value),
  });
  return {
    docs,
    find: () => q(docs),
    findOne: ({ key }) => q(docs.find((d) => d.key === key) ?? null),
    findOneAndUpdate: ({ key }, { $set, $setOnInsert }) => {
      let doc = docs.find((d) => d.key === key);
      if (!doc) {
        doc = { secret: true, description: "", ...$setOnInsert };
        docs.push(doc);
      }
      Object.assign(doc, $set, { updatedAt: new Date() });
      return q(doc);
    },
    findOneAndDelete: ({ key }) => {
      const index = docs.findIndex((d) => d.key === key);
      return q(index < 0 ? null : docs.splice(index, 1)[0]);
    },
  };
};

const stored = (key, value, extra = {}) => ({
  key,
  value: encryptValue(key, value, Buffer.from(HEX_KEY, "hex")),
  secret: true,
  description: "",
  ...extra,
});

test("values are encrypted with AES-256-GCM and bound to their key name", () => {
  const key = parseEncryptionKey(HEX_KEY);
  assert.equal(key.length, 32);
  assert.deepEqual(
    parseEncryptionKey(Buffer.from(HEX_KEY, "hex").toString("base64")),
    key,
  );
  assert.equal(parseEncryptionKey(""), null);
  assert.throws(
    () => parseEncryptionKey("too-short"),
    (e) => e.code === "ENCRYPTION_KEY_INVALID",
  );

  const box = encryptValue("JWT_SECRET", "super-secret-value", key);
  assert.ok(!JSON.stringify(box).includes("super-secret-value"));
  assert.equal(decryptValue("JWT_SECRET", box, key), "super-secret-value");
  // A ciphertext moved to another key name, or a wrong key, fails closed.
  assert.throws(() => decryptValue("SMTP_PASSWORD", box, key), /decrypt/);
  assert.throws(
    () => decryptValue("JWT_SECRET", box, randomBytes(32)),
    /decrypt/,
  );
});

test("masking hides short secrets entirely and shows 4 chars of long ones", () => {
  assert.equal(maskValue("1234"), "••••");
  assert.equal(maskValue("abcdefghijklmnop"), "••••mnop");
});

test("bootstrap and process-level variables are reserved", () => {
  for (const name of [
    "DB_URL",
    ENCRYPTION_KEY_NAME,
    "PORT",
    "NODE_OPTIONS",
    "PATH",
    "LD_PRELOAD",
    "DOPPLER_TOKEN",
  ])
    assert.ok(isReservedKey(name), name);
  assert.ok(!isReservedKey("JWT_SECRET"));
});

test("load: stored values override .env; bad records keep the .env value", async () => {
  const env = {
    [ENCRYPTION_KEY_NAME]: HEX_KEY,
    JWT_SECRET: "from-dotenv",
    SMTP_HOST: "dotenv.example",
    PORT: "5300",
  };
  const broken = stored("SMTP_HOST", "db.example");
  broken.value.tag = Buffer.alloc(16).toString("base64");
  const model = fakeModel([
    stored("JWT_SECRET", "from-db"),
    stored("GEMINI_KEY", "gem-db"),
    broken,
    stored("PORT", "9999"),
  ]);
  const store = createAquaEnvStore({ model, env });
  const summary = await store.load();
  assert.deepEqual(summary.loaded.sort(), ["GEMINI_KEY", "JWT_SECRET"]);
  assert.deepEqual(summary.failed, ["SMTP_HOST"]);
  assert.deepEqual(summary.skipped, ["PORT"]);
  assert.equal(env.JWT_SECRET, "from-db");
  assert.equal(env.GEMINI_KEY, "gem-db");
  assert.equal(env.SMTP_HOST, "dotenv.example");
  assert.equal(env.PORT, "5300", "reserved keys never come from the DB");
  assert.ok(
    !JSON.stringify(summary).includes("from-db"),
    "no values in summary",
  );

  // Without the encryption key nothing is applied and .env stays in use.
  const bare = { JWT_SECRET: "from-dotenv" };
  const none = await createAquaEnvStore({ model, env: bare }).load();
  assert.equal(none.loaded.length, 0);
  assert.equal(none.error, "ENCRYPTION_KEY_MISSING");
  assert.equal(bare.JWT_SECRET, "from-dotenv");
});

test("set/remove: partial updates, live process.env, fallback to .env on delete", async () => {
  const env = { [ENCRYPTION_KEY_NAME]: HEX_KEY, SMTP_HOST: "dotenv.example" };
  const model = fakeModel();
  const store = createAquaEnvStore({ model, env });

  await assert.rejects(
    store.set("SMTP_HOST", {}),
    (e) => e.code === "INVALID_VALUE",
  );
  await assert.rejects(
    store.set("bad-name", { value: "x" }),
    (e) => e.code === "INVALID_KEY",
  );
  await assert.rejects(
    store.set("DB_URL", { value: "x" }),
    (e) => e.code === "RESERVED_KEY",
  );
  await assert.rejects(
    store.set("A", { value: 5 }),
    (e) => e.code === "INVALID_VALUE",
  );

  const created = await store.set("SMTP_HOST", {
    value: "smtp.db.example",
    secret: false,
  });
  assert.equal(created.created, true);
  assert.equal(created.variable.value, "smtp.db.example");
  assert.equal(created.variable.inEffect, true);
  assert.equal(env.SMTP_HOST, "smtp.db.example");
  assert.ok(
    !JSON.stringify(model.docs).includes("smtp.db.example"),
    "encrypted at rest",
  );

  // Description-only update keeps the stored value.
  const described = await store.set("SMTP_HOST", { description: "Mail relay" });
  assert.equal(described.created, false);
  assert.equal(described.variable.value, "smtp.db.example");
  assert.equal(described.variable.description, "Mail relay");

  const secret = await store.set("JWT_SECRET", {
    value: "a-very-long-jwt-secret",
  });
  assert.equal(secret.variable.value, "••••cret");
  assert.equal((await store.get("JWT_SECRET")).value, "••••cret");
  assert.ok(
    (await store.list()).every((v) => !String(v.value).includes("a-very-long")),
  );

  assert.deepEqual(await store.remove("SMTP_HOST"), {
    key: "SMTP_HOST",
    secret: false,
    fallback: "server-env",
  });
  assert.equal(env.SMTP_HOST, "dotenv.example");
  assert.equal((await store.remove("JWT_SECRET")).fallback, "none");
  assert.equal(env.JWT_SECRET, undefined);
  await assert.rejects(store.remove("JWT_SECRET"), (e) => e.status === 404);

  // Writes need the encryption key.
  delete env[ENCRYPTION_KEY_NAME];
  await assert.rejects(
    store.set("X_KEY", { value: "v" }),
    (e) => e.status === 503,
  );
});

const response = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

test("CRM controller: masked responses, status codes, audit without values", async () => {
  const env = { [ENCRYPTION_KEY_NAME]: HEX_KEY };
  const store = createAquaEnvStore({ model: fakeModel(), env });
  const audits = [];
  const controller = createAquaEnvController({
    store,
    audit: async (entry) => audits.push(entry),
  });
  const user = { _id: "staff-1" };

  let res = response();
  await controller.set(
    {
      params: { key: "PHONEPE_KEY" },
      body: { value: "phonepe-salt-123456" },
      user,
    },
    res,
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.value, "••••3456");
  assert.match(res.body.restartNote, /restart/);
  assert.equal(audits[0].action, "settings.env.create");
  assert.equal(audits[0].resourceId, "PHONEPE_KEY");
  assert.ok(
    !JSON.stringify(audits.map(({ req, ...entry }) => entry)).includes(
      "phonepe-salt",
    ),
    "audit has no values",
  );

  res = response();
  await controller.set(
    {
      params: { key: "PHONEPE_KEY" },
      body: { value: "new-salt-abcdefgh" },
      user,
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(audits[1].action, "settings.env.update");
  assert.equal(audits[1].metadata.valueChanged, true);
  assert.equal(env.PHONEPE_KEY, "new-salt-abcdefgh");

  res = response();
  await controller.set(
    { params: { key: "DB_URL" }, body: { value: "x" }, user },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "RESERVED_KEY");

  res = response();
  await controller.list({}, res);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.status.keyConfigured, true);
  assert.ok(!JSON.stringify(res.body).includes("new-salt"));

  res = response();
  await controller.get({ params: { key: "MISSING" } }, res);
  assert.equal(res.statusCode, 404);

  res = response();
  await controller.remove({ params: { key: "PHONEPE_KEY" }, user }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(audits.at(-1).action, "settings.env.delete");
  assert.equal(env.PHONEPE_KEY, undefined);
});

test("settings permissions exist for role assignment", () => {
  assert.ok(PERMISSIONS.includes("settings.read"));
  assert.ok(PERMISSIONS.includes("settings.manage"));
});
