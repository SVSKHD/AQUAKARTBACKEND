import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import AquaEnv from "../models/aquaEnv.js";

// Runtime configuration stored in MongoDB (collection "aqua-env") and edited
// from the CRM. The server's own environment keeps only DB_URL and
// AQUA_ENV_ENCRYPTION_KEY. index.js connects, calls load() so the stored
// values land in process.env, and only then imports the app, so existing
// `process.env.X` reads keep working. Stored values win over .env/Doppler;
// .env is the fallback for keys that are not stored.
//
// Values are encrypted with AES-256-GCM; the key name is bound as
// additional authenticated data, so a ciphertext copied to another key fails
// to decrypt. Plain values are never logged or written to the audit log.

export const ENCRYPTION_KEY_NAME = "AQUA_ENV_ENCRYPTION_KEY";
export const MAX_VALUE_LENGTH = 20000;
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;
const FORMAT_VERSION = 1;

// Deployment and process-level variables that must not come from the CRM:
// the bootstrap pair, the listening port, and variables that change how
// Node, npm, pm2 or the dynamic linker behave.
const RESERVED_KEYS = new Set([
  "DB_URL",
  ENCRYPTION_KEY_NAME,
  "PORT",
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "HOSTNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
]);
const RESERVED_PREFIXES = ["NODE_", "NPM_", "PM2_", "DOPPLER_", "LD_", "DYLD_"];

export const RESTART_NOTE =
  "Applied to process.env on the instance that handled this request. Settings read only at startup (for example Cloudinary, WhatsApp, MCP, the scheduler) take effect after a restart; other instances pick up changes when they restart.";

export class AquaEnvError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const isReservedKey = (name) =>
  RESERVED_KEYS.has(name) ||
  RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

export const normalizeKeyName = (raw) => {
  const name = String(raw ?? "").trim();
  if (!KEY_PATTERN.test(name))
    throw new AquaEnvError(
      "INVALID_KEY",
      "Variable names use capital letters, digits and underscores, start with a letter, and are at most 100 characters.",
    );
  if (isReservedKey(name))
    throw new AquaEnvError(
      "RESERVED_KEY",
      `${name} is set by the server environment and cannot be stored in aqua-env.`,
    );
  return name;
};

const normalizeValue = (raw) => {
  if (typeof raw !== "string")
    throw new AquaEnvError("INVALID_VALUE", "value must be a string.");
  if (raw.length > MAX_VALUE_LENGTH)
    throw new AquaEnvError(
      "INVALID_VALUE",
      `value is longer than ${MAX_VALUE_LENGTH} characters.`,
    );
  return raw;
};

// Accepts 64 hex characters or base64 of exactly 32 bytes. Returns null when
// unset; throws when set but malformed, so a typo is not silently ignored.
export const parseEncryptionKey = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (key.length !== 32)
    throw new AquaEnvError(
      "ENCRYPTION_KEY_INVALID",
      `${ENCRYPTION_KEY_NAME} must be 32 bytes (64 hex characters or base64).`,
      500,
    );
  return key;
};

const aad = (name) => Buffer.from(`aqua-env:${name}`, "utf8");

export const encryptValue = (name, plain, key) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(name));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    v: FORMAT_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
};

export const decryptValue = (name, stored, key) => {
  if (stored?.v !== FORMAT_VERSION)
    throw new AquaEnvError("DECRYPT_FAILED", "Unknown value format.", 500);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(stored.iv, "base64"),
    );
    decipher.setAAD(aad(name));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(stored.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AquaEnvError(
      "DECRYPT_FAILED",
      "Value could not be decrypted with the current encryption key.",
      500,
    );
  }
};

// Short secrets (PINs) are fully hidden; longer ones show the last 4
// characters so staff can tell which credential is stored.
export const maskValue = (value) =>
  value.length >= 12 ? `••••${value.slice(-4)}` : "••••";

export const createAquaEnvStore = ({ model, env = process.env } = {}) => {
  // Value each key had before aqua-env overrode it (undefined = absent), so
  // deleting a stored variable falls back to .env instead of leaving a stale
  // value in process.env.
  const original = new Map();
  let lastLoad = null;

  const currentKey = () => parseEncryptionKey(env[ENCRYPTION_KEY_NAME]);
  // For reads: a missing or malformed key just makes values unreadable.
  const safeKey = () => {
    try {
      return currentKey();
    } catch {
      return null;
    }
  };
  const requireKey = () => {
    const key = currentKey();
    if (!key)
      throw new AquaEnvError(
        "ENCRYPTION_KEY_MISSING",
        `${ENCRYPTION_KEY_NAME} is not set on the server, so aqua-env values cannot be written.`,
        503,
      );
    return key;
  };

  const applyToEnv = (name, value) => {
    if (!original.has(name)) original.set(name, env[name]);
    env[name] = value;
  };
  const restoreEnv = (name) => {
    if (!original.has(name)) return;
    const previous = original.get(name);
    original.delete(name);
    if (previous === undefined) delete env[name];
    else env[name] = previous;
  };

  const view = (doc, key) => {
    let plain = null;
    let readable = false;
    if (key) {
      try {
        plain = decryptValue(doc.key, doc.value, key);
        readable = true;
      } catch {
        readable = false;
      }
    }
    return {
      key: doc.key,
      secret: doc.secret !== false,
      value:
        plain === null ? null : doc.secret !== false ? maskValue(plain) : plain,
      readable,
      inEffect: readable && env[doc.key] === plain,
      description: doc.description || "",
      updatedBy: doc.updatedBy ?? null,
      createdAt: doc.createdAt ?? null,
      updatedAt: doc.updatedAt ?? null,
    };
  };

  return {
    // Reads every stored variable into env. Never throws for a single bad
    // record: it is reported by name and the .env value (if any) stays.
    async load() {
      let key = null;
      let keyError = null;
      try {
        key = currentKey();
      } catch (error) {
        keyError = error.code;
      }
      const docs = await model.find({}).lean();
      const summary = {
        at: new Date().toISOString(),
        total: docs.length,
        loaded: [],
        failed: [],
        skipped: [],
        keyConfigured: Boolean(key),
        error: keyError,
      };
      for (const doc of docs) {
        if (isReservedKey(doc.key)) summary.skipped.push(doc.key);
        else if (!key) summary.failed.push(doc.key);
        else {
          try {
            applyToEnv(doc.key, decryptValue(doc.key, doc.value, key));
            summary.loaded.push(doc.key);
          } catch {
            summary.failed.push(doc.key);
          }
        }
      }
      if (!key && docs.length && !keyError)
        summary.error = "ENCRYPTION_KEY_MISSING";
      lastLoad = summary;
      return summary;
    },

    status() {
      return { keyConfigured: Boolean(safeKey()), lastLoad };
    },

    async list() {
      const key = safeKey();
      const docs = await model.find({}).sort({ key: 1 }).lean();
      return docs.map((doc) => view(doc, key));
    },

    async get(rawName) {
      const name = String(rawName ?? "").trim();
      const doc = await model.findOne({ key: name }).lean();
      if (!doc)
        throw new AquaEnvError("NOT_FOUND", `${name} is not stored.`, 404);
      return view(doc, safeKey());
    },

    // Create or update. value is required on create; on update omitted
    // fields keep their stored values (partial update).
    async set(rawName, input = {}, actorId = null) {
      const name = normalizeKeyName(rawName);
      const existing = await model.findOne({ key: name }).lean();
      const hasValue = input.value !== undefined;
      if (!existing && !hasValue)
        throw new AquaEnvError("INVALID_VALUE", "value is required.");
      const update = { updatedBy: actorId };
      let plain;
      if (hasValue) {
        plain = normalizeValue(input.value);
        update.value = encryptValue(name, plain, requireKey());
      }
      if (input.secret !== undefined) {
        if (typeof input.secret !== "boolean")
          throw new AquaEnvError(
            "INVALID_SECRET",
            "secret must be true or false.",
          );
        update.secret = input.secret;
      }
      if (input.description !== undefined) {
        if (input.description !== null && typeof input.description !== "string")
          throw new AquaEnvError(
            "INVALID_DESCRIPTION",
            "description must be a string.",
          );
        const description = String(input.description ?? "").trim();
        if (description.length > 300)
          throw new AquaEnvError(
            "INVALID_DESCRIPTION",
            "description is longer than 300 characters.",
          );
        update.description = description;
      }
      const doc = await model
        .findOneAndUpdate(
          { key: name },
          { $set: update, $setOnInsert: { key: name } },
          {
            new: true,
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        )
        .lean();
      if (hasValue) applyToEnv(name, plain);
      return {
        created: !existing,
        previous: existing
          ? {
              secret: existing.secret !== false,
              description: existing.description || "",
            }
          : null,
        variable: view(doc, safeKey()),
      };
    },

    // Reserved names are allowed here so a record inserted by mistake can
    // still be removed.
    async remove(rawName) {
      const name = String(rawName ?? "").trim();
      const doc = await model.findOneAndDelete({ key: name }).lean();
      if (!doc)
        throw new AquaEnvError("NOT_FOUND", `${name} is not stored.`, 404);
      restoreEnv(name);
      return {
        key: name,
        secret: doc.secret !== false,
        fallback: env[name] === undefined ? "none" : "server-env",
      };
    },
  };
};

export const aquaEnvStore = createAquaEnvStore({ model: AquaEnv });
