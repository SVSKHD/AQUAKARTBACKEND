import { randomUUID } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { MCP_SCOPE_LIST } from "../services/mcp/config.js";
import { createAquakartMcpServer } from "../services/mcp/server.js";
import { buildMcpServices } from "../services/mcp/index.js";

// Remote MCP server (Streamable HTTP, stateless) at /v1/mcp, protected by
// OAuth 2.1. The OAuth endpoints (/.well-known/*, /authorize, /token,
// /register, /revoke) live at the API root because the issuer is the API
// origin; app.js mounts `mcpOAuthRouter` there. Mounted before the global
// body parsers so the MCP body limit applies. Without MCP_PUBLIC_BASE_URL
// both routers answer 503 MCP_DISABLED.

const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;
const jsonRpcError = (res, status, code, message) =>
  res
    .status(status)
    .json({ jsonrpc: "2.0", error: { code, message }, id: null });

export const createMcpRouters = ({
  config,
  provider,
  blogTools,
  instagramTools,
}) => {
  const router = express.Router();
  const oauthRouter = express.Router();

  if (!config.enabled) {
    router.use((_req, res) =>
      jsonRpcError(
        res,
        503,
        -32000,
        "MCP_DISABLED: set MCP_PUBLIC_BASE_URL to enable",
      ),
    );
    return { router, oauthRouter };
  }

  const resourceUrl = new URL(config.resourceUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  oauthRouter.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.issuerUrl),
      resourceServerUrl: resourceUrl,
      scopesSupported: MCP_SCOPE_LIST,
      resourceName: "Aquakart MCP",
    }),
  );

  router.use((req, res, next) => {
    const incoming = req.get("x-correlation-id");
    req.correlationId =
      incoming && CORRELATION.test(incoming) ? incoming : randomUUID();
    res.set("X-Correlation-Id", req.correlationId);
    res.set("Cache-Control", "no-store");
    next();
  });

  // Staff sign-in/consent form submit. Tight per-IP limit: it takes a password.
  router.post(
    "/oauth/consent",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res, next) => provider.handleConsent(req, res).catch(next),
  );

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl,
    expectedResource: resourceUrl,
  });
  const perGrantLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: config.rateLimitPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.extra?.grantId || "anonymous",
    handler: (_req, res) =>
      jsonRpcError(
        res,
        429,
        -32029,
        "RATE_LIMITED: too many MCP requests; slow down",
      ),
  });
  // Large enough for an 8 MB image sent as base64.
  const body = express.json({ limit: "12mb" });

  router.post("/", bearer, perGrantLimit, body, async (req, res) => {
    const auth = {
      clientId: req.auth.clientId,
      clientName: req.auth.extra?.clientName,
      adminUserId: req.auth.extra?.adminUserId,
      scopes: req.auth.scopes,
    };
    const server = createAquakartMcpServer({
      blogTools,
      instagramTools,
      auth,
      correlationId: req.correlationId,
      resourceMetadataUrl,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [resourceUrl.host],
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error.message);
      if (!res.headersSent)
        jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });
  // Stateless server: no SSE stream or session to delete.
  router.get("/", (_req, res) =>
    jsonRpcError(res.set("Allow", "POST"), 405, -32000, "Method not allowed"),
  );
  router.delete("/", (_req, res) =>
    jsonRpcError(res.set("Allow", "POST"), 405, -32000, "Method not allowed"),
  );

  router.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large")
      return jsonRpcError(res, 413, -32000, "PAYLOAD_TOO_LARGE");
    if (error?.type === "entity.parse.failed")
      return jsonRpcError(res, 400, -32700, "Parse error");
    console.error("MCP route error:", error?.message);
    return jsonRpcError(res, 500, -32603, "Internal server error");
  });

  return { router, oauthRouter };
};

export const mcpServices = buildMcpServices();
const routers = createMcpRouters(mcpServices);
export const mcpOAuthRouter = routers.oauthRouter;
export default routers.router;
