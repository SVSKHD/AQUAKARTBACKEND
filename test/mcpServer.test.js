import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { createMcpRouters } from "../src/routes/mcp.js";
import { createOAuthProvider } from "../src/services/mcp/oauthProvider.js";
import { createBlogTools } from "../src/services/mcp/blogTools.js";
import { createInstagramTools } from "../src/services/mcp/instagramTools.js";
import {
  createClock,
  createFakeGraph,
  createFakeUploader,
  createMemoryStore,
  matches,
  objectId,
  runnerFor,
  testConfig,
} from "./support/mcpFakes.js";

// End-to-end over HTTP: OAuth discovery, dynamic client registration, PKCE
// authorization with staff consent, token exchange/refresh/revocation, and
// MCP initialize / tools/list / tools/call through the real SDK transport.
// Data stores, Cloudinary and Meta are in-memory fakes.

const memoryOAuthStore = (staff) => {
  const clients = [];
  const requests = [];
  const codes = [];
  const tokens = [];
  return {
    tokens,
    getClient: async (clientId) =>
      clients.find((c) => c.clientId === clientId && !c.disabled) || null,
    saveClient: async (doc) => {
      const saved = { ...doc, createdAt: new Date() };
      clients.push(saved);
      return saved;
    },
    saveRequest: async (doc) => requests.push({ ...doc, consumedAt: null }),
    findRequest: async (hash, now) =>
      requests.find(
        (r) => r.requestHash === hash && !r.consumedAt && r.expiresAt > now,
      ) || null,
    consumeRequest: async (hash, now) => {
      const request = requests.find(
        (r) => r.requestHash === hash && !r.consumedAt && r.expiresAt > now,
      );
      if (!request) return null;
      request.consumedAt = now;
      return request;
    },
    saveCode: async (doc) => codes.push({ ...doc, usedAt: null }),
    findCode: async (hash) => codes.find((c) => c.codeHash === hash) || null,
    useCode: async (hash, clientId, now) => {
      const code = codes.find(
        (c) =>
          matches(c, { codeHash: hash, clientId, usedAt: null }) &&
          c.expiresAt > now,
      );
      if (!code) return null;
      code.usedAt = now;
      return code;
    },
    saveTokens: async (docs) =>
      tokens.push(
        ...docs.map((doc) => ({
          _id: objectId(),
          ...doc,
          rotatedAt: null,
          revokedAt: null,
        })),
      ),
    findToken: async (hash) => tokens.find((t) => t.tokenHash === hash) || null,
    rotateRefresh: async (id, now) => {
      const record = tokens.find(
        (t) => t._id === id && !t.rotatedAt && !t.revokedAt,
      );
      if (!record) return null;
      record.rotatedAt = now;
      return record;
    },
    revokeGrant: async (grantId, reason, now) => {
      for (const t of tokens)
        if (t.grantId === grantId && !t.revokedAt)
          Object.assign(t, { revokedAt: now, revokedReason: reason });
    },
    touchToken: async () => {},
    findStaffByEmail: async (email) =>
      email.trim().toLowerCase() === staff.email
        ? {
            ...staff,
            validatePassword: async (pw) => pw === "correct-horse-battery",
          }
        : null,
    findStaffById: async (id) =>
      String(id) === String(staff._id) ? { ...staff } : null,
  };
};

const startServer = async () => {
  let app;
  const server = http.createServer((req, res) => app(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = testConfig({ MCP_PUBLIC_BASE_URL: base });
  const clock = createClock(new Date().toISOString());
  const store = createMemoryStore(clock);
  const staff = {
    _id: objectId(),
    email: "editor@aquakart.co.in",
    role: 2,
    status: "active",
    roleRef: {
      slug: "content-editor",
      isActive: true,
      permissions: ["blogs.manage"],
    },
  };
  const oauthStore = memoryOAuthStore(staff);
  const provider = createOAuthProvider({ config, store: oauthStore });
  const runOperation = runnerFor(store, clock);
  const blogTools = createBlogTools({
    store,
    uploader: createFakeUploader(),
    runOperation,
    config,
    now: clock.now,
  });
  const instagramTools = createInstagramTools({
    store,
    uploader: createFakeUploader(),
    graph: createFakeGraph(clock),
    runOperation,
    config,
    now: clock.now,
  });
  const { router, oauthRouter } = createMcpRouters({
    config,
    provider,
    blogTools,
    instagramTools,
  });
  app = express();
  app.use(oauthRouter);
  app.use("/v1/mcp", router);
  return {
    server,
    base,
    config,
    store,
    staff,
    oauthStore,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const form = (data) =>
  new URLSearchParams(
    Object.entries(data).flatMap(([key, value]) =>
      [].concat(value).map((item) => [key, item]),
    ),
  );
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

const authorize = async (
  env,
  clientId,
  { scope, tick, password = "correct-horse-battery" },
) => {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state: "state-123",
    resource: env.config.resourceUrl,
  });
  const page = await fetch(`${env.base}/authorize?${query}`);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)[1];
  const consent = await fetch(`${env.base}/v1/mcp/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      request_id: requestId,
      email: "Editor@Aquakart.co.in",
      password,
      scope: tick,
      decision: "approve",
    }),
  });
  return { consent, verifier, requestId, html };
};

const exchange = (env, body) =>
  fetch(`${env.base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(body),
  });

let rpcId = 0;
const rpc = async (env, token, method, params = {}) => {
  const response = await fetch(`${env.base}/v1/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
};
const call = (env, token, name, args) =>
  rpc(env, token, "tools/call", { name, arguments: args });

test("ChatGPT-style OAuth + MCP flow: discovery, consent, tools and scope enforcement", async (t) => {
  const env = await startServer();
  t.after(env.close);

  const resourceMeta = await (
    await fetch(`${env.base}/.well-known/oauth-protected-resource/v1/mcp`)
  ).json();
  assert.equal(resourceMeta.resource, env.config.resourceUrl);
  assert.deepEqual(resourceMeta.authorization_servers, [`${env.base}/`]);
  assert.ok(resourceMeta.scopes_supported.includes("instagram:publish"));
  const asMeta = await (
    await fetch(`${env.base}/.well-known/oauth-authorization-server`)
  ).json();
  assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
  assert.equal(asMeta.registration_endpoint, `${env.base}/register`);

  // Registration only for allowlisted redirect URIs; never issues a secret.
  const evil = await fetch(`${env.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://evil.example/callback"],
      client_name: "Evil",
    }),
  });
  assert.equal(evil.status, 400);
  const registered = await fetch(`${env.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      client_name: "ChatGPT",
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  assert.match(client.client_id, /^mcp_/);
  assert.equal(client.client_secret, undefined);
  assert.equal(client.token_endpoint_auth_method, "none");

  // Wrong password re-shows the form; the right one grants only permitted scopes.
  const wrong = await authorize(env, client.client_id, {
    scope: "blogs:read blogs:write instagram:read",
    tick: ["blogs:read"],
    password: "nope-nope",
  });
  assert.equal(wrong.consent.status, 400);
  assert.match(await wrong.consent.text(), /incorrect/);
  const { consent, verifier } = await authorize(env, client.client_id, {
    scope: "blogs:read blogs:write instagram:read",
    tick: ["blogs:read", "blogs:write", "instagram:read", "blogs:publish"],
  });
  assert.equal(consent.status, 302);
  const location = new URL(consent.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get("state"), "state-123");
  const code = location.searchParams.get("code");

  const tokenResponse = await exchange(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    resource: env.config.resourceUrl,
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  // instagram:read was ticked but the staff member lacks instagram.publish;
  // blogs:publish was never requested.
  assert.equal(tokens.scope, "blogs:read blogs:write");
  assert.match(tokens.access_token, /^aqm_at_/);
  assert.ok(
    env.oauthStore.tokens.every(
      (record) => !JSON.stringify(record).includes(tokens.access_token),
    ),
    "only hashes are stored",
  );

  // Missing and invalid tokens get an OAuth challenge pointing at metadata.
  const anonymous = await rpc(env, null, "tools/list");
  assert.equal(anonymous.status, 401);
  assert.match(
    anonymous.headers.get("www-authenticate"),
    /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/v1\/mcp"/,
  );
  assert.equal(
    (await rpc(env, "aqm_at_forged-token-value", "tools/list")).status,
    401,
  );
  assert.equal((await rpc(env, "Bearer-not-ours", "tools/list")).status, 401);

  const init = await rpc(env, tokens.access_token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "aquakart");
  assert.ok(init.body.result.capabilities.tools);

  const list = await rpc(env, tokens.access_token, "tools/list");
  const tools = Object.fromEntries(
    list.body.result.tools.map((tool) => [tool.name, tool]),
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    "aquakart_attach_image",
    "aquakart_cleanup_instagram_asset",
    "aquakart_create_blog",
    "aquakart_create_image_upload",
    "aquakart_get_blog",
    "aquakart_get_blog_status",
    "aquakart_get_brand_assets",
    "aquakart_get_image_upload",
    "aquakart_get_instagram_status",
    "aquakart_list_blogs",
    "aquakart_list_instagram_posts",
    "aquakart_publish_blog",
    "aquakart_publish_instagram",
    "aquakart_update_blog",
    "aquakart_upload_image",
    "aquakart_upload_instagram_image",
  ]);
  assert.equal(
    tools.aquakart_create_blog.inputSchema.additionalProperties,
    false,
  );
  assert.ok(tools.aquakart_create_blog.outputSchema);
  assert.deepEqual(tools.aquakart_publish_blog._meta.securitySchemes, [
    { type: "oauth2", scopes: ["blogs:publish"] },
  ]);
  assert.deepEqual(tools.aquakart_upload_image._meta["openai/fileParams"], [
    "image",
  ]);
  assert.deepEqual(
    tools.aquakart_upload_image.inputSchema.properties.image.required.sort(),
    ["download_url", "file_id"],
  );
  assert.equal(tools.aquakart_list_blogs.annotations.readOnlyHint, true);
  assert.equal(
    tools.aquakart_cleanup_instagram_asset.annotations.destructiveHint,
    true,
  );

  const created = await call(env, tokens.access_token, "aquakart_create_blog", {
    idempotencyKey: "blog-e2e-0001",
    title: "Water Softener Buying Guide for Hyderabad Homes",
    description:
      "<h2>Intro</h2><p>Hard water in Hyderabad is common. <script>x()</script></p>",
  });
  assert.equal(created.body.result.isError, undefined);
  const draft = created.body.result.structuredContent;
  assert.equal(draft.ok, true);
  assert.equal(draft.blog.status, "draft");
  assert.deepEqual(draft.warnings, ["HTML_SANITIZED"]);
  assert.equal(env.store.blogs[0].integration.createdBy, env.staff._id);

  const replay = await call(env, tokens.access_token, "aquakart_create_blog", {
    idempotencyKey: "blog-e2e-0001",
    title: "Water Softener Buying Guide for Hyderabad Homes",
    description:
      "<h2>Intro</h2><p>Hard water in Hyderabad is common. <script>x()</script></p>",
  });
  assert.equal(replay.body.result.structuredContent.replayed, true);
  assert.equal(env.store.blogs.length, 1);

  const listed = await call(env, tokens.access_token, "aquakart_list_blogs", {
    status: "draft",
  });
  assert.equal(listed.body.result.structuredContent.total, 1);

  const publish = await call(
    env,
    tokens.access_token,
    "aquakart_publish_blog",
    { idempotencyKey: "pub-e2e-0001", blogId: draft.blog.blogId },
  );
  assert.equal(publish.body.result.isError, true);
  assert.equal(
    JSON.parse(publish.body.result.content[0].text).error.code,
    "INSUFFICIENT_SCOPE",
  );
  assert.match(
    publish.body.result._meta["mcp/www_authenticate"][0],
    /error="insufficient_scope".*scope="[^"]*blogs:publish/,
  );
  const ig = await call(
    env,
    tokens.access_token,
    "aquakart_list_instagram_posts",
    {},
  );
  assert.equal(
    JSON.parse(ig.body.result.content[0].text).error.code,
    "INSUFFICIENT_SCOPE",
  );
  assert.equal(env.store.blogs[0].status, "draft");

  const unknownArg = await call(
    env,
    tokens.access_token,
    "aquakart_create_blog",
    {
      idempotencyKey: "blog-e2e-0002",
      title: "Another Title For a Blog Post",
      description: "<p>x</p>",
      status: "published",
    },
  );
  assert.equal(unknownArg.body.result.isError, true);
  assert.equal(env.store.blogs.length, 1);

  // Refresh rotates; replaying the old refresh token revokes the grant.
  const refreshed = await (
    await exchange(env, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    })
  ).json();
  assert.match(refreshed.access_token, /^aqm_at_/);
  assert.equal(
    (await rpc(env, refreshed.access_token, "tools/list")).status,
    200,
  );
  const reuse = await exchange(env, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal(
    (await rpc(env, refreshed.access_token, "tools/list")).status,
    401,
  );

  // Codes are single-use.
  const codeReuse = await exchange(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  assert.equal(codeReuse.status, 400);
});

test("publishing needs an explicitly granted scope, and disabling staff cuts access", async (t) => {
  const env = await startServer();
  t.after(env.close);
  const registered = await (
    await fetch(`${env.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:33418/callback"],
        client_name: "Claude Code",
        token_endpoint_auth_method: "none",
      }),
    })
  ).json();
  assert.match(
    registered.client_id,
    /^mcp_/,
    "loopback redirects (Claude Code) are accepted",
  );

  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: "http://localhost:33418/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "blogs:read blogs:publish",
  });
  const html = await (await fetch(`${env.base}/authorize?${query}`)).text();
  assert.match(html, /value="blogs:read" checked/);
  assert.match(html, /value="blogs:publish">/, "publish starts unticked");
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)[1];
  const consent = await fetch(`${env.base}/v1/mcp/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      request_id: requestId,
      email: env.staff.email,
      password: "correct-horse-battery",
      scope: ["blogs:read", "blogs:publish"],
      decision: "approve",
    }),
  });
  const code = new URL(consent.headers.get("location")).searchParams.get(
    "code",
  );
  const tokens = await (
    await exchange(env, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: registered.client_id,
      redirect_uri: "http://localhost:33418/callback",
    })
  ).json();
  assert.equal(tokens.scope, "blogs:read blogs:publish");

  const missing = await call(
    env,
    tokens.access_token,
    "aquakart_publish_blog",
    { idempotencyKey: "pub-e2e-0001", blogId: objectId() },
  );
  assert.equal(
    JSON.parse(missing.body.result.content[0].text).error.code,
    "BLOG_NOT_FOUND",
  );

  // Removing the CRM permission or disabling the account applies immediately.
  env.staff.roleRef.permissions = [];
  const stripped = await call(
    env,
    tokens.access_token,
    "aquakart_list_blogs",
    {},
  );
  assert.equal(
    JSON.parse(stripped.body.result.content[0].text).error.code,
    "INSUFFICIENT_SCOPE",
  );
  env.staff.status = "disabled";
  assert.equal((await rpc(env, tokens.access_token, "tools/list")).status, 401);

  // Denying consent redirects with access_denied.
  const again = await (await fetch(`${env.base}/authorize?${query}`)).text();
  const deny = await fetch(`${env.base}/v1/mcp/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      request_id: /name="request_id" value="([^"]+)"/.exec(again)[1],
      decision: "deny",
    }),
  });
  assert.equal(
    new URL(deny.headers.get("location")).searchParams.get("error"),
    "access_denied",
  );
});

test("the MCP endpoint answers 503 when MCP_PUBLIC_BASE_URL is not set", async (t) => {
  const { router, oauthRouter } = createMcpRouters({
    config: { enabled: false },
  });
  const app = express();
  app.use(oauthRouter);
  app.use("/v1/mcp", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/v1/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.equal(
    (await fetch(`${base}/.well-known/oauth-authorization-server`)).status,
    404,
  );
});

// Codex-style client: follows the 401 challenge to discovery, registers a
// public client with a loopback redirect (DCR), signs in with PKCE, then
// uploads a local PNG through a one-time upload URL (no base64 in tool
// arguments), saves a draft idempotently, attaches the banner with the
// official logo and alt text, and reads the draft back. Nothing is published.
test("Codex-style flow: challenge → discovery → DCR → PKCE → upload URL → draft → read-back", async (t) => {
  const env = await startServer();
  t.after(env.close);
  const LOOPBACK = "http://127.0.0.1:53682/callback";
  const SCOPES = "blogs:read blogs:write media:upload blogs:publish";

  // 1. Unauthenticated initialize → 401 with resource_metadata.
  const challenge = await rpc(env, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex", version: "test" },
  });
  assert.equal(challenge.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    challenge.headers.get("www-authenticate"),
  )[1];

  // 2. Discovery: protected resource (path-suffixed and root) → AS metadata.
  const resource = await (await fetch(metadataUrl)).json();
  assert.equal(resource.resource, env.config.resourceUrl);
  for (const scope of SCOPES.split(" "))
    assert.ok(resource.scopes_supported.includes(scope), scope);
  const rootResource = await fetch(
    `${env.base}/.well-known/oauth-protected-resource`,
  );
  assert.equal(rootResource.status, 200);
  assert.deepEqual(await rootResource.json(), resource);
  const issuer = resource.authorization_servers[0];
  const as = await (
    await fetch(new URL("/.well-known/oauth-authorization-server", issuer))
  ).json();
  assert.equal(as.issuer, issuer);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));
  assert.ok(as.grant_types_supported.includes("refresh_token"));
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);

  // 3. Dynamic client registration: public client, loopback redirect.
  const registered = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Codex",
      redirect_uris: [LOOPBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.equal(client.client_secret, undefined);

  // 4. Authorization code + PKCE with staff sign-in and consent.
  const { verifier, challenge: codeChallenge } = pkce();
  const page = await fetch(
    `${as.authorization_endpoint}?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: LOOPBACK,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: SCOPES,
      state: "codex-state",
      resource: resource.resource,
    })}`,
  );
  assert.equal(page.status, 200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(
    await page.text(),
  )[1];
  const consent = await fetch(`${env.base}/v1/mcp/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      request_id: requestId,
      email: "editor@aquakart.co.in",
      password: "correct-horse-battery",
      scope: SCOPES.split(" "),
      decision: "approve",
    }),
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location"));
  assert.equal(`${callback.origin}${callback.pathname}`, LOOPBACK);
  assert.equal(callback.searchParams.get("state"), "codex-state");

  // 5. Token exchange (PKCE, resource-bound), then refresh.
  const tokens = await (
    await exchange(env, {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: LOOPBACK,
      resource: resource.resource,
    })
  ).json();
  assert.equal(tokens.scope, SCOPES);
  assert.ok(tokens.refresh_token);
  const refreshed = await (
    await exchange(env, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: resource.resource,
    })
  ).json();
  assert.match(refreshed.access_token, /^aqm_at_/);
  const token = refreshed.access_token;

  // 6. MCP initialize (protocol negotiation) and tool discovery.
  const init = await rpc(env, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex", version: "test" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  const listed = await rpc(env, token, "tools/list");
  const tools = Object.fromEntries(
    listed.body.result.tools.map((tool) => [tool.name, tool]),
  );
  for (const name of [
    "aquakart_list_blogs",
    "aquakart_get_blog",
    "aquakart_create_blog",
    "aquakart_update_blog",
    "aquakart_create_image_upload",
    "aquakart_get_image_upload",
    "aquakart_attach_image",
    "aquakart_publish_blog",
  ])
    assert.ok(tools[name], name);
  assert.match(tools.aquakart_create_image_upload.description, /curl/);
  assert.ok(tools.aquakart_create_blog.inputSchema.properties.titleImageAlt);

  // 7. Banner upload through a one-time URL (raw bytes, no bearer header).
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    randomBytes(64),
  ]);
  const session = (await call(env, token, "aquakart_create_image_upload", {}))
    .body.result.structuredContent;
  assert.equal(session.ok, true);
  const { uploadUrl, uploadId } = session.upload;
  assert.ok(uploadUrl.startsWith(`${env.config.resourceUrl}/uploads/`));
  const notImage = await fetch(uploadUrl, {
    method: "PUT",
    body: Buffer.from("definitely not an image file"),
  });
  assert.equal(notImage.status, 415);
  const pendingAgain = (
    await call(env, token, "aquakart_get_image_upload", { uploadId })
  ).body.result.structuredContent;
  assert.equal(pendingAgain.upload.status, "pending");
  assert.equal(pendingAgain.upload.lastError.code, "UNSUPPORTED_IMAGE_TYPE");
  const put = await fetch(uploadUrl, { method: "PUT", body: png });
  assert.equal(put.status, 201);
  const uploaded = await put.json();
  assert.equal(uploaded.uploadId, uploadId);
  const reuse = await fetch(uploadUrl, { method: "PUT", body: png });
  assert.equal(reuse.status, 409);
  const unknown = await fetch(
    `${env.config.resourceUrl}/uploads/${"x".repeat(43)}`,
    { method: "PUT", body: png },
  );
  assert.equal(unknown.status, 404);
  const status = (
    await call(env, token, "aquakart_get_image_upload", { uploadId })
  ).body.result.structuredContent;
  assert.equal(status.upload.status, "uploaded");
  const { mediaId } = status.media;
  assert.equal(mediaId, uploaded.media.mediaId);
  assert.equal(env.store.media[0].source, "upload-url");

  // 8. Draft with SEO fields; a retry with the same key is not duplicated.
  const draftArgs = {
    idempotencyKey: "codex-draft-0001",
    title: "How Hard Water Affects Geysers in Hyderabad",
    slug: "hard-water-geysers-hyderabad",
    description:
      "<h2>Why geysers scale</h2><p>Hard water leaves calcium deposits on heating elements.</p>",
    summary: "Scale from hard water shortens geyser life; here is what helps.",
    shortDescription:
      "Hard water scale damages geysers in Hyderabad homes. Learn the signs and how a water softener prevents it.",
    keywords: ["hard water", "geyser scale"],
    titleImageAlt: "Aquakart water softener next to a bathroom geyser",
  };
  const created = (await call(env, token, "aquakart_create_blog", draftArgs))
    .body.result.structuredContent;
  assert.equal(created.blog.status, "draft");
  assert.equal(created.blog.adminUrl, null);
  const retry = (await call(env, token, "aquakart_create_blog", draftArgs)).body
    .result.structuredContent;
  assert.equal(retry.replayed, true);
  assert.equal(retry.blog.blogId, created.blog.blogId);
  assert.equal(env.store.blogs.length, 1);

  // 9. Attach the banner with the official logo overlay and alt text.
  const attached = (
    await call(env, token, "aquakart_attach_image", {
      idempotencyKey: "codex-attach-0001",
      blogId: created.blog.blogId,
      mediaId,
      applyBrandLogo: true,
      altText: "Aquakart softener protecting a geyser from scale",
    })
  ).body.result.structuredContent;
  assert.equal(attached.ok, true);
  assert.equal(attached.logoApplied, true);
  assert.equal(
    attached.titleImageAlt,
    "Aquakart softener protecting a geyser from scale",
  );

  // 10. Read back the persisted draft.
  const saved = (
    await call(env, token, "aquakart_get_blog", {
      blogId: created.blog.blogId,
    })
  ).body.result.structuredContent.blog;
  assert.equal(saved.status, "draft");
  assert.equal(saved.slug, "hard-water-geysers-hyderabad");
  assert.equal(saved.summary, draftArgs.summary);
  assert.equal(saved.shortDescription, draftArgs.shortDescription);
  assert.equal(saved.keywords, "hard water, geyser scale");
  assert.equal(
    saved.titleImageAlt,
    "Aquakart softener protecting a geyser from scale",
  );
  assert.equal(saved.titleImages[0].id, uploaded.media.publicId);
  assert.equal(saved.publicUrl, null);
  assert.equal(env.store.blogs[0].status, "draft", "nothing was published");
});
