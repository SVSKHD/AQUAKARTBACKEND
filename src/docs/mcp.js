// Explicit contract for the Aquakart MCP server and its OAuth endpoints.
// MCP is JSON-RPC over Streamable HTTP, so swagger-autogen can't infer it;
// tool schemas are discovered with tools/list (see docs/MCP_BLOG_PUBLISHING.md).
const TAG = "MCP";
const jsonRpc = {
  type: "object",
  properties: {
    jsonrpc: { type: "string", example: "2.0" },
    id: { type: "integer", example: 1 },
    method: { type: "string", example: "tools/call" },
    params: { type: "object" },
  },
  required: ["jsonrpc", "method"],
};
const oauthError = {
  type: "object",
  properties: {
    error: { type: "string", example: "invalid_grant" },
    error_description: { type: "string" },
  },
};

export const applyMcpDocs = (doc) => {
  doc.paths ||= {};
  // swagger-autogen infers a trailing-slash duplicate of router.post("/"),
  // and follows the root-mounted mcpOAuthRouter import into routes/mcp.js,
  // listing the MCP routes again at "/" and "/oauth/consent".
  delete doc.paths["/v1/mcp/"];
  delete doc.paths["/oauth/consent"];
  if (doc.paths["/"] && !doc.paths["/"].put && !doc.paths["/"].patch)
    delete doc.paths["/"];
  doc.paths["/v1/mcp"] = {
    post: {
      tags: [TAG],
      summary: "MCP endpoint (Streamable HTTP, stateless)",
      description:
        "JSON-RPC 2.0 MCP requests: initialize, tools/list, tools/call. Requires `Authorization: Bearer <OAuth access token>` bound to this resource; send `Accept: application/json, text/event-stream`. Tools: aquakart_list_blogs, aquakart_get_blog, aquakart_get_blog_status (blogs:read); aquakart_create_blog, aquakart_update_blog, aquakart_attach_image (blogs:write); aquakart_upload_image (media:upload); aquakart_publish_blog (blogs:publish); aquakart_get_instagram_status, aquakart_list_instagram_posts (instagram:read); aquakart_upload_instagram_image (instagram:upload); aquakart_publish_instagram (instagram:publish); aquakart_cleanup_instagram_asset (instagram:cleanup). Tool errors return result.isError with structuredContent.error.code. Body limit 12 MB; rate limit MCP_RATE_LIMIT_PER_MINUTE per grant. 503 when MCP_PUBLIC_BASE_URL is unset.",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "body", in: "body", required: true, schema: jsonRpc },
      ],
      responses: {
        200: { description: "JSON-RPC response" },
        401: {
          description:
            "Missing/invalid token; WWW-Authenticate carries resource_metadata",
        },
        413: { description: "Body too large" },
        429: { description: "Rate limited" },
        503: { description: "MCP disabled" },
      },
    },
    get: {
      tags: [TAG],
      summary: "Not supported (stateless server)",
      responses: { 405: { description: "Use POST" } },
    },
    delete: {
      tags: [TAG],
      summary: "Not supported (stateless server)",
      responses: { 405: { description: "Use POST" } },
    },
  };
  doc.paths["/v1/mcp/oauth/consent"] = {
    post: {
      tags: [TAG],
      summary: "Staff sign-in and consent form submit",
      description:
        "Posted by the HTML page from /authorize. Staff sign in with CRM email/password; each granted scope needs its CRM permission (blogs.manage or instagram.publish). Redirects to the client's registered redirect_uri with code+state, or error=access_denied. 10 requests / 15 min per IP.",
      consumes: ["application/x-www-form-urlencoded"],
      parameters: [
        { name: "request_id", in: "formData", type: "string", required: true },
        { name: "email", in: "formData", type: "string" },
        {
          name: "password",
          in: "formData",
          type: "string",
          format: "password",
        },
        {
          name: "scope",
          in: "formData",
          type: "array",
          items: { type: "string" },
          collectionFormat: "multi",
        },
        {
          name: "decision",
          in: "formData",
          type: "string",
          enum: ["approve", "deny"],
        },
      ],
      responses: {
        302: { description: "Redirect to client" },
        400: { description: "Form re-shown with an error, or request expired" },
      },
    },
  };
  const oauth = (path, summary, description, method = "post", extra = {}) => {
    doc.paths[path] = {
      [method]: {
        tags: [TAG],
        summary,
        description,
        responses: {
          200: { description: "OK" },
          400: { description: "OAuth error", schema: oauthError },
          ...extra,
        },
      },
    };
  };
  oauth(
    "/.well-known/oauth-protected-resource/v1/mcp",
    "Protected resource metadata (RFC 9728)",
    "resource, authorization_servers, scopes_supported.",
    "get",
  );
  oauth(
    "/.well-known/oauth-authorization-server",
    "Authorization server metadata (RFC 8414)",
    "Endpoints, S256 PKCE, grant types, scopes.",
    "get",
  );
  oauth(
    "/register",
    "Dynamic client registration (RFC 7591)",
    "Public clients only (no secret issued). redirect_uris must match MCP_OAUTH_ALLOWED_REDIRECT_URIS or be loopback when allowed.",
    "post",
    { 201: { description: "Registered" } },
  );
  oauth(
    "/authorize",
    "Authorization (PKCE S256)",
    "Validates the request and renders the staff sign-in/consent page.",
    "get",
  );
  oauth(
    "/token",
    "Token endpoint",
    "authorization_code (with code_verifier) and refresh_token grants. Refresh tokens rotate; reuse revokes the grant.",
  );
  oauth(
    "/revoke",
    "Token revocation (RFC 7009)",
    "Revokes the whole grant of the given token.",
  );
  doc.securityDefinitions ||= {};
  doc.securityDefinitions.bearerAuth ||= {
    type: "apiKey",
    name: "Authorization",
    in: "header",
  };
  return doc;
};
