import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthProvider } from "../src/services/mcp/oauthProvider.js";
import {
  loadMcpConfig,
  redirectUriAllowed,
} from "../src/services/mcp/config.js";

// Dynamic client registration: only allowlisted redirect URIs are stored,
// extra unlisted ones are dropped instead of failing the whole request, and
// every attempt leaves a diagnosable log line.

const setup = () => {
  const config = loadMcpConfig({
    MCP_PUBLIC_BASE_URL: "https://api.aquakart.co.in",
  });
  const saved = [];
  const lines = [];
  const provider = createOAuthProvider({
    config,
    store: {
      saveClient: async (doc) => {
        saved.push(doc);
        return { ...doc, createdAt: new Date("2026-11-06T00:00:00Z") };
      },
    },
    log: { log: (line) => lines.push(JSON.parse(line)), error() {} },
  });
  return { config, provider, saved, lines };
};

test("ChatGPT callback URIs, including per-connector ids, are accepted", () => {
  const { config } = setup();
  for (const uri of [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/AbC_12-x",
    "https://chatgpt.com/connector/oauth/abc/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:33418/callback",
  ])
    assert.equal(redirectUriAllowed(uri, config), true, uri);
  for (const uri of [
    "https://chatgpt.com/connector/oauth/../steal",
    "https://chatgpt.com/connector/oauth/a?next=https://evil.example",
    "https://chatgpt.com.evil.example/connector/oauth/a",
    "https://chatgpt.com/connector/oauth/",
  ])
    assert.equal(redirectUriAllowed(uri, config), false, uri);
});

test("unlisted extra redirect URIs are dropped, not fatal, and logged", async () => {
  const { provider, saved, lines } = setup();
  const client = await provider.clientsStore.registerClient({
    client_name: "ChatGPT",
    redirect_uris: [
      "https://chatgpt.com/connector/oauth/cb123",
      "https://platform.example/other-callback",
    ],
    token_endpoint_auth_method: "client_secret_post",
    client_secret: "sdk-generated-secret",
  });
  assert.deepEqual(client.redirect_uris, [
    "https://chatgpt.com/connector/oauth/cb123",
  ]);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.equal(client.client_secret, undefined);
  assert.deepEqual(saved[0].redirectUris, [
    "https://chatgpt.com/connector/oauth/cb123",
  ]);
  assert.equal(lines[0].event, "mcp.oauth.register");
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].reason, "dropped_unlisted_redirect_uris");
  assert.deepEqual(lines[0].refused, [
    "https://platform.example/other-callback",
  ]);
  assert.equal(lines[0].requestedAuthMethod, "client_secret_post");
  assert.ok(!JSON.stringify(lines).includes("sdk-generated-secret"));
});

test("registration with no allowlisted redirect URI fails and says why", async () => {
  const { provider, saved, lines } = setup();
  await assert.rejects(
    provider.clientsStore.registerClient({
      client_name: "Unknown",
      redirect_uris: ["https://evil.example/cb"],
    }),
    /redirect_uri not allowed: https:\/\/evil\.example\/cb/,
  );
  assert.equal(saved.length, 0);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].reason, "no_allowed_redirect_uri");
});
