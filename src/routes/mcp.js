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
  catalogTools,
  taxonomySeoTools,
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
  // One JSON log line per failed OAuth request (registration, authorize,
  // token, revoke), so client connection problems are diagnosable. Never
  // logs codes, tokens, secrets or PKCE verifiers.
  oauthRouter.use(
    ["/register", "/authorize", "/token", "/revoke"],
    (req, res, next) => {
      res.on("finish", () => {
        if (
          res.statusCode < 400 &&
          !(
            res.statusCode === 302 &&
            /[?&]error=/.test(res.get("location") || "")
          )
        )
          return;
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const path = req.originalUrl.split("?")[0];
        const location =
          res.statusCode === 302
            ? new URL(res.get("location"), config.baseUrl)
            : null;
        console.log(
          JSON.stringify({
            event: "mcp.oauth.failed",
            path,
            method: req.method,
            status: res.statusCode,
            error: location?.searchParams.get("error") || undefined,
            errorDescription:
              location?.searchParams.get("error_description") || undefined,
            clientId:
              String(req.query.client_id || body.client_id || "").slice(
                0,
                120,
              ) || undefined,
            clientName:
              path === "/register"
                ? String(body.client_name || "").slice(0, 100)
                : undefined,
            redirectUris:
              path === "/register" && Array.isArray(body.redirect_uris)
                ? body.redirect_uris.slice(0, 10).map(String)
                : undefined,
            redirectUri:
              String(req.query.redirect_uri || body.redirect_uri || "").slice(
                0,
                300,
              ) || undefined,
            authMethod:
              path === "/register"
                ? body.token_endpoint_auth_method
                : undefined,
            grantType: path === "/token" ? body.grant_type : undefined,
            userAgent: String(req.get("user-agent") || "").slice(0, 120),
          }),
        );
      });
      next();
    },
  );
  oauthRouter.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.issuerUrl),
      resourceServerUrl: resourceUrl,
      scopesSupported: MCP_SCOPE_LIST,
      resourceName: "Aquakart MCP",
    }),
  );
  // RFC 9728 path-less form. Clients should follow the resource_metadata URL
  // in the 401 challenge (path-suffixed, served above), but some probe the
  // root first; serve the same document there.
  const resourceMetadata = {
    resource: resourceUrl.href,
    authorization_servers: [new URL(config.issuerUrl).href],
    scopes_supported: MCP_SCOPE_LIST,
    resource_name: "Aquakart MCP",
  };
  oauthRouter.get("/.well-known/oauth-protected-resource", (_req, res) =>
    res
      .set("Access-Control-Allow-Origin", "*")
      .set("Cache-Control", "public, max-age=3600")
      .json(resourceMetadata),
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

  // One-time image upload URLs from aquakart_create_image_upload. The token
  // in the path is the credential (one successful upload, expires), so no
  // bearer header: shells and curl never see the OAuth access token. The
  // token is never logged.
  const UPLOAD_STATUS = {
    UPLOAD_NOT_FOUND: 404,
    UPLOAD_ALREADY_USED: 409,
    UPLOAD_IN_PROGRESS: 409,
    VALIDATION_FAILED: 400,
    IMAGE_TOO_LARGE: 413,
    UNSUPPORTED_IMAGE_TYPE: 415,
  };
  const uploadLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  router.put(
    "/uploads/:token",
    uploadLimit,
    express.raw({ type: () => true, limit: config.imageMaxBytes + 1 }),
    async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
      try {
        const result = await blogTools.completeImageUpload(
          req.params.token,
          req.body,
          { correlationId: req.correlationId },
        );
        console.log(
          JSON.stringify({
            event: "mcp.upload.completed",
            uploadId: result.uploadId,
            mediaId: result.media.mediaId,
            bytes,
            deduplicated: result.deduplicated,
            correlationId: req.correlationId,
          }),
        );
        return res.status(201).json({
          ok: true,
          uploadId: result.uploadId,
          media: result.media,
          deduplicated: result.deduplicated,
          next: "Attach media.mediaId with aquakart_attach_image (or check aquakart_get_image_upload).",
          correlationId: req.correlationId,
        });
      } catch (error) {
        const status = UPLOAD_STATUS[error?.code] || 500;
        console.log(
          JSON.stringify({
            event: "mcp.upload.failed",
            status,
            code: error?.code || "UPLOAD_FAILED",
            bytes,
            contentType: String(req.get("content-type") || "").slice(0, 60),
            correlationId: req.correlationId,
          }),
        );
        if (status === 500)
          console.error("MCP upload failed:", error?.message || error);
        return res.status(status).json({
          ok: false,
          error: {
            code: status === 500 ? "UPLOAD_FAILED" : error.code,
            message:
              status === 500
                ? "Storing the image failed; retry the same URL before it expires"
                : error.message,
          },
          correlationId: req.correlationId,
        });
      }
    },
  );

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
      catalogTools,
      taxonomySeoTools,
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
