// In-memory stand-ins for MongoDB, Cloudinary and Meta used by the MCP
// tests. They mirror the conditions of src/services/mcp/store.js closely
// enough to exercise idempotency, leases and crash recovery. No network.
import { randomBytes } from "node:crypto";
import { GraphError } from "../../src/services/mcp/instagramGraph.js";
import { loadMcpConfig } from "../../src/services/mcp/config.js";
import { createOperationRunner } from "../../src/services/mcp/operations.js";

export const objectId = () => randomBytes(12).toString("hex");
export const clone = (value) =>
  value === undefined ? value : structuredClone(value);

export const createClock = (start = "2026-11-06T03:00:00.000Z") => {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
};

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(64),
]);
export const pngBase64 = (seed = "") =>
  Buffer.concat([PNG, Buffer.from(seed)])
    .toString("base64")
    .replace(/=+$/, (pad) => pad);
export const GIF = Buffer.from("GIF89a" + "x".repeat(32));

const get = (doc, path) =>
  path.split(".").reduce((value, key) => value?.[key], doc);
const setPath = (doc, path, value) => {
  const keys = path.split(".");
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (target[key] === undefined || target[key] === null) target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
};

// Small subset of MongoDB query matching used by the stores.
export const matches = (doc, query = {}) =>
  Object.entries(query).every(([key, condition]) => {
    if (key === "$or") return condition.some((part) => matches(doc, part));
    if (key === "$and") return condition.every((part) => matches(doc, part));
    const value = get(doc, key);
    if (
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date) &&
      !Array.isArray(condition)
    ) {
      return Object.entries(condition).every(([op, operand]) => {
        if (op === "$in") return operand.includes(value);
        if (op === "$nin") return !operand.includes(value);
        if (op === "$ne")
          return operand === null
            ? value !== null && value !== undefined
            : String(value) !== String(operand);
        if (op === "$lt")
          return value !== null && value !== undefined && value < operand;
        if (op === "$lte")
          return value !== null && value !== undefined && value <= operand;
        if (op === "$gt")
          return value !== null && value !== undefined && value > operand;
        return false;
      });
    }
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date)
      return value instanceof Date && value.getTime() === condition.getTime();
    return String(value) === String(condition);
  });

export const applyUpdate = (doc, change = {}) => {
  for (const [path, value] of Object.entries(change.$set || {}))
    setPath(doc, path, clone(value));
  for (const [path, value] of Object.entries(change.$inc || {}))
    setPath(doc, path, (get(doc, path) || 0) + value);
  for (const [path, value] of Object.entries(change.$push || {})) {
    const list = get(doc, path) || [];
    const items = value.$each ? value.$each : [value];
    let next = [...list, ...clone(items)];
    if (value.$slice) next = next.slice(value.$slice);
    setPath(doc, path, next);
  }
  return doc;
};

const duplicateKey = () =>
  Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

export const createMemoryStore = (clock) => {
  const blogs = [];
  const media = [];
  const operations = [];
  const assets = [];
  const categories = new Map();
  const products = new Set();
  const calls = { createBlog: 0, failNextAssetUpdate: null };
  const tickUpdatedAt = () => {
    clock.advance(1);
    return clock.now();
  };

  const store = {
    blogs,
    media,
    operations,
    assets,
    categories,
    products,
    calls,

    // Blogs
    findBlog: async ({ blogId, slug }) =>
      clone(blogs.find((b) => (blogId ? b._id === blogId : b.slug === slug))) ||
      null,
    listBlogs: async ({ status, query, skip, limit }) => {
      let items = blogs.filter((b) =>
        status === "draft"
          ? b.status === "draft"
          : status === "published"
            ? b.status !== "draft"
            : true,
      );
      if (query)
        items = items.filter((b) =>
          b.title.toLowerCase().includes(query.toLowerCase()),
        );
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
    slugTaken: async (slug, excludeId) =>
      blogs.some((b) => b.slug === slug && b._id !== excludeId),
    publishedSlugTaken: async (slug, excludeId) =>
      blogs.some(
        (b) => b.slug === slug && b.status !== "draft" && b._id !== excludeId,
      ),
    findBlogByContentHash: async (hash) =>
      clone(blogs.find((b) => b.integration?.contentHash === hash)) || null,
    listTitles: async () => blogs.map(({ _id, title }) => ({ _id, title })),
    taxonomyError: async ({ category, subCategory }) => {
      if (category && !categories.has(category))
        return "Selected category was not found";
      if (subCategory && categories.get(category) !== subCategory)
        return "Selected subcategory does not belong to the category";
      return "";
    },
    productExists: async (id) => products.has(id),
    createBlog: async (doc) => {
      calls.createBlog += 1;
      if (
        doc.integration?.contentHash &&
        blogs.some(
          (b) => b.integration?.contentHash === doc.integration.contentHash,
        )
      ) {
        throw duplicateKey();
      }
      const saved = { _id: objectId(), ...clone(doc) };
      blogs.push(saved);
      return clone(saved);
    },
    updateBlog: async (id, condition, change) => {
      const doc = blogs.find((b) => b._id === id);
      if (!doc || !matches(doc, condition)) return null;
      applyUpdate(doc, change);
      doc.updatedAt = tickUpdatedAt(); // mirrors the schema's update hook
      return clone(doc);
    },
    firstPublicBlogIdBySlug: async (slug) =>
      blogs.find((b) => b.slug === slug && b.status !== "draft")?._id || null,
    blogsUsingImage: async (publicId, excludeBlogId) =>
      blogs.some(
        (b) =>
          b._id !== String(excludeBlogId) &&
          (b.titleImages || []).some((img) => img.id === publicId),
      ),

    // Media
    findMediaBySha: async (sha256) =>
      clone(media.find((m) => m.sha256 === sha256)) || null,
    findMediaById: async (id) => clone(media.find((m) => m._id === id)) || null,
    findMediaByPublicId: async (publicId) =>
      clone(media.find((m) => m.publicId === publicId)) || null,
    createMedia: async (doc) => {
      if (media.some((m) => m.sha256 === doc.sha256)) throw duplicateKey();
      const saved = { _id: objectId(), ...clone(doc) };
      media.push(saved);
      return clone(saved);
    },
    updateMedia: async (id, set) => {
      const doc = media.find((m) => String(m._id) === String(id));
      if (!doc) return null;
      Object.assign(doc, clone(set));
      return clone(doc);
    },

    // Operations
    createOperation: async (doc) => {
      if (
        operations.some(
          (o) =>
            o.clientId === doc.clientId &&
            o.idempotencyKey === doc.idempotencyKey,
        )
      )
        throw duplicateKey();
      const saved = { attempts: 1, ...clone(doc) };
      operations.push(saved);
      return clone(saved);
    },
    findOperation: async (clientId, key) =>
      clone(
        operations.find(
          (o) => o.clientId === clientId && o.idempotencyKey === key,
        ),
      ) || null,
    reclaimOperation: async (existing, set) => {
      const doc = operations.find(
        (o) =>
          o.operationId === existing.operationId &&
          o.status === existing.status &&
          o.attempts === existing.attempts,
      );
      if (!doc) return null;
      Object.assign(doc, {
        status: "processing",
        retryable: false,
        ...clone(set),
        attempts: doc.attempts + 1,
      });
      return clone(doc);
    },
    finishOperation: async (operationId, set) => {
      Object.assign(
        operations.find((o) => o.operationId === operationId),
        clone(set),
      );
    },

    // Instagram assets
    findAsset: async (assetId) =>
      clone(assets.find((a) => a.assetId === assetId)) || null,
    findAssetBySha: async (sha256) =>
      clone(assets.find((a) => a.sha256 === sha256)) || null,
    createAsset: async (doc) => {
      if (assets.some((a) => a.sha256 === doc.sha256)) throw duplicateKey();
      const saved = {
        createdAt: clock.now(),
        publishAttempts: 0,
        cleanupAttempts: 0,
        reconcileAttempts: 0,
        ...clone(doc),
      };
      assets.push(saved);
      return clone(saved);
    },
    updateAsset: async (assetId, condition, change) => {
      if (calls.failNextAssetUpdate && calls.failNextAssetUpdate(change)) {
        calls.failNextAssetUpdate = null;
        const error = new Error("Database write failed");
        error.code = "STORAGE_UNAVAILABLE";
        throw error;
      }
      const doc = assets.find((a) => a.assetId === assetId);
      if (!doc || !matches(doc, condition)) return null;
      applyUpdate(doc, change);
      return clone(doc);
    },
    listAssets: async ({ status, skip, limit }) => {
      const items = assets
        .filter((a) => !status || a.status === status)
        .reverse();
      return {
        items: clone(items.slice(skip, skip + limit)),
        total: items.length,
      };
    },
    claimDueCleanup: async (now, lockUntil) => {
      const doc = assets
        .filter((a) =>
          matches(a, {
            status: "CLEANUP_PENDING",
            cleanupStatus: { $in: ["pending", "in_progress"] },
            cleanupAfter: { $ne: null, $lte: now },
            $and: [
              {
                $or: [
                  { cleanupNextAttemptAt: null },
                  { cleanupNextAttemptAt: { $lte: now } },
                ],
              },
              {
                $or: [
                  { cleanupLockedUntil: null },
                  { cleanupLockedUntil: { $lt: now } },
                ],
              },
            ],
          }),
        )
        .sort((a, b) => a.cleanupAfter - b.cleanupAfter)[0];
      if (!doc) return null;
      Object.assign(doc, {
        cleanupStatus: "in_progress",
        cleanupLockedUntil: lockUntil,
      });
      return clone(doc);
    },
    findAssetsToReconcile: async (now, limit) =>
      clone(
        assets
          .filter((a) =>
            matches(a, {
              reconcileAttempts: { $lt: 20 },
              $or: [
                { status: "PUBLISH_UNCERTAIN" },
                {
                  status: "PUBLISHING",
                  $or: [
                    { publishLockedUntil: null },
                    { publishLockedUntil: { $lt: now } },
                  ],
                },
              ],
            }),
          )
          .slice(0, limit),
      ),
  };
  return store;
};

export const createFakeUploader = () => {
  const uploaded = new Map();
  const destroyed = [];
  const uploader = {
    uploaded,
    destroyed,
    dimensions: { width: 1080, height: 1350 },
    failDestroy: 0,
    download: async () => {
      throw new Error("no network in tests");
    },
    uploadImage: async (buffer, { publicId }) => {
      uploaded.set(publicId, buffer);
      return {
        public_id: publicId,
        secure_url: `https://res.cloudinary.com/demo/image/upload/${publicId}.png`,
        width: 1200,
        height: 630,
        bytes: buffer.length,
        format: "png",
      };
    },
    uploadTemp: async (buffer, { publicId }) => {
      uploaded.set(publicId, buffer);
      return {
        public_id: publicId,
        secure_url: `https://res.cloudinary.com/demo/image/upload/${publicId}.png`,
        ...uploader.dimensions,
        bytes: buffer.length,
        format: "png",
      };
    },
    destroyTemp: async (publicId) => {
      if (uploader.failDestroy > 0) {
        uploader.failDestroy -= 1;
        throw Object.assign(new Error("Cloudinary 500"), { http_code: 500 });
      }
      destroyed.push(publicId);
      const existed = uploaded.delete(publicId);
      return { result: existed ? "ok" : "not found" };
    },
    destroy: async (publicId) => {
      destroyed.push(publicId);
      uploaded.delete(publicId);
      return { result: "ok" };
    },
    brandedUrl: (publicId) =>
      `https://res.cloudinary.com/demo/image/upload/l_logo/${publicId}`,
    jpegUrl: (publicId) =>
      `https://res.cloudinary.com/demo/image/upload/q_90/${publicId}.jpg`,
  };
  return uploader;
};

// Scriptable stand-in for createInstagramGraph().
export const createFakeGraph = (clock) => {
  const graph = {
    containers: new Map(),
    media: new Map(),
    calls: {
      createContainer: 0,
      publishContainer: 0,
      getContainer: 0,
      getMedia: 0,
    },
    containerStates: [], // queued status_code answers for getContainer
    failPublish: null, // "timeout-after-publish" | "timeout-before-publish" | GraphError
    failGetContainer: false,
    failCreate: null,
    createContainer: async ({ imageUrl, caption }) => {
      graph.calls.createContainer += 1;
      if (graph.failCreate) throw graph.failCreate;
      const id = `1789${graph.containers.size + 1}`;
      graph.containers.set(id, {
        id,
        status_code: "IN_PROGRESS",
        imageUrl,
        caption,
      });
      return id;
    },
    getContainer: async (id) => {
      graph.calls.getContainer += 1;
      if (graph.failGetContainer)
        throw new GraphError("META_TIMEOUT", "timeout", { transient: true });
      const container = graph.containers.get(id);
      if (!container) throw new GraphError("META_NOT_FOUND", "not found");
      if (graph.containerStates.length)
        container.status_code = graph.containerStates.shift();
      else if (container.status_code === "IN_PROGRESS")
        container.status_code = "FINISHED";
      return {
        id,
        status_code: container.status_code,
        status:
          container.status_code === "ERROR"
            ? "Error: unsupported image"
            : undefined,
      };
    },
    publishContainer: async (id) => {
      graph.calls.publishContainer += 1;
      const container = graph.containers.get(id);
      const mode = graph.failPublish;
      if (mode && typeof mode === "object") throw mode;
      if (mode === "timeout-before-publish") {
        throw new GraphError("META_TIMEOUT", "Meta did not answer in time", {
          transient: true,
        });
      }
      if (container.status_code === "PUBLISHED") {
        throw new GraphError("META_REQUEST_REJECTED", "already published");
      }
      const mediaId = `1801${graph.media.size + 1}`;
      container.status_code = "PUBLISHED";
      graph.media.set(mediaId, {
        id: mediaId,
        permalink: `https://www.instagram.com/p/C${mediaId}/`,
        timestamp: clock.now().toISOString(),
        caption: container.caption,
      });
      if (mode === "timeout-after-publish") {
        throw new GraphError("META_TIMEOUT", "Meta did not answer in time", {
          transient: true,
        });
      }
      return mediaId;
    },
    getMedia: async (id) => {
      graph.calls.getMedia += 1;
      const media = graph.media.get(id);
      if (!media) throw new GraphError("META_NOT_FOUND", "not found");
      return media;
    },
    recentMedia: async () => [...graph.media.values()].reverse(),
  };
  return graph;
};

export const testConfig = (overrides = {}) => {
  const config = loadMcpConfig({
    MCP_PUBLIC_BASE_URL: "http://localhost:5300",
    INSTAGRAM_USER_ID: "17841400000000000",
    INSTAGRAM_ACCESS_TOKEN: "test-token-not-real-0000000000",
    INSTAGRAM_CONTAINER_POLL_INTERVAL_SECONDS: "1",
    MCP_PUBLISH_MIN_WORDS: "20",
    ...overrides,
  });
  return config;
};

export const ctxFor = (scopes = [], overrides = {}) => ({
  auth: {
    clientId: "mcp_test-client",
    clientName: "Test client",
    adminUserId: "64b000000000000000000001",
    scopes,
    ...overrides,
  },
  correlationId: "test-correlation-id",
});

export const runnerFor = (store, clock, lockMs = 120000) =>
  createOperationRunner({ store, now: clock.now, lockMs });
