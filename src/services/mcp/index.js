import mongoose from "mongoose";
import { writeAudit } from "../audit.js";
import { loadMcpConfig } from "./config.js";
import { createOperationRunner } from "./operations.js";
import { createBlogTools } from "./blogTools.js";
import { createInstagramTools } from "./instagramTools.js";
import { createInstagramGraph } from "./instagramGraph.js";
import { createOAuthProvider } from "./oauthProvider.js";
import { cloudinaryUploader, mongoStore } from "./store.js";

// Builds the production MCP services from the environment.

const audit = ({ action, adminUserId, resourceType, resourceId, metadata }) =>
  writeAudit({
    req: { user: { _id: adminUserId } },
    action,
    resourceType,
    resourceId,
    metadata,
  });

export const buildMcpServices = (env = process.env) => {
  const config = loadMcpConfig(env);
  const runOperation = createOperationRunner({
    store: mongoStore,
    lockMs: config.operationLockMs,
  });
  return {
    config,
    provider: config.enabled ? createOAuthProvider({ config }) : null,
    blogTools: createBlogTools({
      store: mongoStore,
      uploader: cloudinaryUploader,
      runOperation,
      config,
      audit,
    }),
    instagramTools: createInstagramTools({
      store: mongoStore,
      uploader: cloudinaryUploader,
      graph: createInstagramGraph(config.instagram),
      runOperation,
      config,
      audit,
    }),
  };
};

// Durable delayed-work loop for Instagram temp-image cleanup (and
// reconciling uncertain publishes). Needed because cleanup must happen
// cleanupAfter minutes after a post, without the MCP client staying
// connected. All state lives in MongoDB (cleanupAfter, leases, attempts),
// so it resumes after restarts and is safe with several instances. It is
// not a schedule: it only acts on records that asked for cleanup.
export const startInstagramCleanupWorker = ({ instagramTools, config }) => {
  const ig = config.instagram;
  if (!config.enabled || !ig.configured || !ig.workerEnabled) return null;
  let timer;
  let stopped = false;
  const loop = async () => {
    try {
      if (mongoose.connection.readyState === 1) {
        const summary = await instagramTools.runMaintenancePass();
        if (
          summary.cleaned ||
          summary.retried ||
          summary.blocked ||
          summary.reconciled
        ) {
          console.log(
            JSON.stringify({ event: "mcp.instagram.maintenance", ...summary }),
          );
        }
      }
    } catch (error) {
      console.error("Instagram cleanup pass failed:", error.message);
    } finally {
      if (!stopped) timer = setTimeout(loop, ig.cleanupPollMs);
    }
  };
  timer = setTimeout(loop, 15000);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
