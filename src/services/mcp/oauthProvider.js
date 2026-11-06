import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import AquaAdminUser from "../../models/crm/adminUser.js";
import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthRequest,
  McpOAuthToken,
} from "../../models/mcp/oauth.js";
import { staffHasPermission } from "../../middleware/permissions.js";
import {
  MCP_PATH,
  MCP_SCOPE_LIST,
  SCOPE_PERMISSIONS,
  redirectUriAllowed,
} from "./config.js";
import {
  consentSecurityHeaders,
  renderConsentPage,
  renderMessagePage,
} from "./consentPage.js";

// OAuth 2.1 authorization server + token verifier for the Aquakart MCP
// server, plugged into the MCP SDK's mcpAuthRouter (metadata, /authorize,
// /token, /register, /revoke). Staff authorize with their CRM login and
// need the CRM permission behind each scope (SCOPE_PERMISSIONS).
// - clients are public (PKCE S256, no stored secret), redirect URIs are
//   allowlisted at registration
// - codes and tokens are random, stored as SHA-256 only, codes single-use
// - refresh tokens rotate; reusing an old one revokes the whole grant
// - every request re-checks the staff account and its permissions, so
//   disabling staff or removing a permission takes effect immediately

export const sha256 = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const token = (prefix) => `${prefix}${randomBytes(32).toString("base64url")}`;
const sameResource = (a, b) =>
  String(a || "").replace(/\/$/, "") === String(b || "").replace(/\/$/, "");

export const mongoOAuthStore = {
  getClient: (clientId) =>
    McpOAuthClient.findOne({ clientId, disabled: { $ne: true } }).lean(),
  saveClient: async (doc) => (await McpOAuthClient.create(doc)).toObject(),
  saveRequest: (doc) => McpOAuthRequest.create(doc),
  findRequest: (requestHash, now) =>
    McpOAuthRequest.findOne({
      requestHash,
      consumedAt: null,
      expiresAt: { $gt: now },
    }).lean(),
  consumeRequest: (requestHash, now) =>
    McpOAuthRequest.findOneAndUpdate(
      { requestHash, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { returnDocument: "after" },
    ).lean(),
  saveCode: (doc) => McpOAuthCode.create(doc),
  findCode: (codeHash) => McpOAuthCode.findOne({ codeHash }).lean(),
  useCode: (codeHash, clientId, now) =>
    McpOAuthCode.findOneAndUpdate(
      { codeHash, clientId, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { returnDocument: "after" },
    ).lean(),
  saveTokens: (docs) => McpOAuthToken.insertMany(docs),
  findToken: (tokenHash) => McpOAuthToken.findOne({ tokenHash }).lean(),
  rotateRefresh: (id, now) =>
    McpOAuthToken.findOneAndUpdate(
      { _id: id, rotatedAt: null, revokedAt: null },
      { $set: { rotatedAt: now } },
      { returnDocument: "after" },
    ).lean(),
  revokeGrant: (grantId, reason, now) =>
    McpOAuthToken.updateMany(
      { grantId, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: reason } },
    ),
  touchToken: (id, now) =>
    McpOAuthToken.updateOne({ _id: id }, { $set: { lastUsedAt: now } }),
  findStaffByEmail: (email) =>
    AquaAdminUser.findOne({
      email: String(email || "")
        .trim()
        .toLowerCase(),
    }).populate("roleRef"),
  findStaffById: (id) =>
    AquaAdminUser.findById(id)
      .select("email firstName lastName role roleRef status directPermissions")
      .populate("roleRef")
      .lean(),
};

const toClientInfo = (client) => ({
  ...(client.metadata || {}),
  client_id: client.clientId,
  client_id_issued_at: Math.floor(
    new Date(client.createdAt || Date.now()).getTime() / 1000,
  ),
  client_name: client.clientName,
  redirect_uris: client.redirectUris,
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
});

// Scopes the staff member is allowed to hold right now.
export const permittedScopes = (staff, scopes) =>
  scopes.filter(
    (scope) =>
      SCOPE_PERMISSIONS[scope] &&
      staffHasPermission(staff, SCOPE_PERMISSIONS[scope]),
  );

export const createOAuthProvider = ({
  config,
  store = mongoOAuthStore,
  now = () => new Date(),
  log = console,
}) => {
  const consentAction = `${config.baseUrl}${MCP_PATH}/oauth/consent`;
  const consentLogo = {
    light: config.brand?.badgeUrl,
    dark: config.brand?.badgeWhiteUrl,
  };

  const issueTokens = async ({
    clientId,
    adminUser,
    grantId,
    scopes,
    resource,
  }) => {
    const at = now();
    const accessToken = token("aqm_at_");
    const refreshToken = token("aqm_rt_");
    const common = { clientId, adminUser, grantId, scopes, resource };
    await store.saveTokens([
      {
        ...common,
        kind: "access",
        tokenHash: sha256(accessToken),
        expiresAt: new Date(at.getTime() + config.accessTokenTtlSeconds * 1000),
      },
      {
        ...common,
        kind: "refresh",
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(
          at.getTime() + config.refreshTokenTtlSeconds * 1000,
        ),
      },
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  };

  const activeStaff = async (adminUserId) => {
    const staff = await store.findStaffById(adminUserId);
    return staff && staff.status !== "disabled" ? staff : null;
  };

  const clientsStore = {
    getClient: async (clientId) => {
      const client = await store.getClient(clientId);
      return client ? toClientInfo(client) : undefined;
    },
    // Dynamic Client Registration (RFC 7591). Only allowlisted redirect URIs
    // are registered: extra, unlisted URIs a client offers are dropped (it can
    // never be redirected to them); with none allowed the request fails.
    // Registered as a public PKCE client, so no secret is issued or stored.
    registerClient: async (client) => {
      const offered = (client.redirect_uris || []).map(String);
      const uris = offered.filter((uri) => redirectUriAllowed(uri, config));
      const refused = offered.filter((uri) => !uris.includes(uri));
      const logLine = (ok, reason) =>
        log.log(
          JSON.stringify({
            event: "mcp.oauth.register",
            ok,
            reason,
            clientName: String(client.client_name || "").slice(0, 100),
            redirectUris: offered.slice(0, 10),
            refused: refused.slice(0, 10),
            requestedAuthMethod: client.token_endpoint_auth_method || null,
          }),
        );
      if (!uris.length) {
        logLine(false, "no_allowed_redirect_uri");
        throw new InvalidClientMetadataError(
          `redirect_uri not allowed: ${refused.join(", ") || "none given"}`,
        );
      }
      logLine(
        true,
        refused.length ? "dropped_unlisted_redirect_uris" : undefined,
      );
      const {
        client_secret: _secret,
        client_secret_expires_at: _expires,
        client_id: _id,
        client_id_issued_at: _issued,
        redirect_uris: _uris,
        ...metadata
      } = client;
      const saved = await store.saveClient({
        clientId: `mcp_${randomUUID()}`,
        clientName: String(client.client_name || "MCP client").slice(0, 100),
        redirectUris: uris,
        metadata: {
          client_name: metadata.client_name,
          client_uri: metadata.client_uri,
          logo_uri: metadata.logo_uri,
          scope: metadata.scope,
          software_id: metadata.software_id,
          software_version: metadata.software_version,
        },
      });
      return toClientInfo(saved);
    },
  };

  const resolveScopes = (requested) => {
    const scopes = requested?.length ? requested : MCP_SCOPE_LIST;
    const unknown = scopes.filter((scope) => !MCP_SCOPE_LIST.includes(scope));
    if (unknown.length)
      throw new InvalidScopeError(`Unknown scope: ${unknown.join(", ")}`);
    return [...new Set(scopes)];
  };

  return {
    clientsStore,

    async authorize(client, params, res) {
      if (
        params.resource &&
        !sameResource(params.resource.href, config.resourceUrl)
      ) {
        throw new InvalidTargetError(
          "This authorization server only issues tokens for the Aquakart MCP server",
        );
      }
      const scopes = resolveScopes(params.scopes);
      const requestId = randomBytes(32).toString("base64url");
      await store.saveRequest({
        requestHash: sha256(requestId),
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes,
        state: params.state,
        resource: config.resourceUrl,
        expiresAt: new Date(now().getTime() + 10 * 60000),
      });
      consentSecurityHeaders(res, params.redirectUri, consentLogo);
      res
        .status(200)
        .type("html")
        .send(
          renderConsentPage({
            logo: consentLogo,
            action: consentAction,
            requestId,
            clientName: client.client_name,
            redirectUri: params.redirectUri,
            scopes,
          }),
        );
    },

    // POST /v1/mcp/oauth/consent (form from renderConsentPage).
    async handleConsent(req, res) {
      const body = req.body || {};
      const requestId =
        typeof body.request_id === "string" ? body.request_id : "";
      const pending = requestId
        ? await store.findRequest(sha256(requestId), now())
        : null;
      if (!pending) {
        res.status(400).set("Cache-Control", "no-store").type("html");
        return res.send(
          renderMessagePage(
            "Sign-in link expired",
            "Start the connection again from your MCP client.",
          ),
        );
      }
      const client = await store.getClient(pending.clientId);
      const redirect = (params) => {
        const url = new URL(pending.redirectUri);
        for (const [key, value] of Object.entries(params))
          if (value) url.searchParams.set(key, value);
        if (pending.state) url.searchParams.set("state", pending.state);
        return res.redirect(302, url.href);
      };
      const again = (error) => {
        consentSecurityHeaders(res, pending.redirectUri, consentLogo);
        return res
          .status(400)
          .type("html")
          .send(
            renderConsentPage({
              logo: consentLogo,
              action: consentAction,
              requestId,
              clientName: client?.clientName,
              redirectUri: pending.redirectUri,
              scopes: pending.scopes,
              email: typeof body.email === "string" ? body.email : "",
              error,
            }),
          );
      };

      if (body.decision === "deny") {
        await store.consumeRequest(sha256(requestId), now());
        return redirect({
          error: "access_denied",
          error_description: "The staff member denied access",
        });
      }
      if (!client) return again("This client is no longer registered.");
      const staff =
        typeof body.email === "string" && typeof body.password === "string"
          ? await store.findStaffByEmail(body.email)
          : null;
      const passwordOk = staff
        ? await staff.validatePassword(body.password)
        : false;
      if (!staff || !passwordOk)
        return again("Email or password is incorrect.");
      if (staff.status === "disabled")
        return again("This staff account is disabled.");

      const ticked = []
        .concat(body.scope || [])
        .filter((scope) => pending.scopes.includes(scope));
      const granted = permittedScopes(staff, ticked);
      if (!granted.length) {
        return again(
          "Choose at least one access your account is permitted to grant (blogs need blogs.manage; Instagram needs instagram.publish; products need products.read/products.manage; coupons need coupons.read/coupons.manage; categories need products.read/products.manage; SEO needs seo.read/seo.manage).",
        );
      }
      const consumed = await store.consumeRequest(sha256(requestId), now());
      if (!consumed)
        return again(
          "This sign-in was already used. Start again from your MCP client.",
        );

      const code = randomBytes(32).toString("base64url");
      await store.saveCode({
        codeHash: sha256(code),
        clientId: pending.clientId,
        adminUser: staff._id,
        scopes: granted,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        resource: pending.resource,
        grantId: `grant_${randomUUID()}`,
        expiresAt: new Date(now().getTime() + 5 * 60000),
      });
      console.log(
        JSON.stringify({
          event: "mcp.oauth.consent",
          clientId: pending.clientId,
          adminUser: String(staff._id),
          scopes: granted,
        }),
      );
      return redirect({ code });
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const code = await store.findCode(sha256(authorizationCode));
      if (
        !code ||
        code.clientId !== client.client_id ||
        code.usedAt ||
        code.expiresAt <= now()
      ) {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      return code.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client,
      authorizationCode,
      _verifier,
      redirectUri,
      resource,
    ) {
      const codeHash = sha256(authorizationCode);
      const code = await store.useCode(codeHash, client.client_id, now());
      if (!code) {
        const replayed = await store.findCode(codeHash);
        // A reused code means it leaked: end everything issued from it.
        if (replayed?.usedAt)
          await store.revokeGrant(replayed.grantId, "code_reuse", now());
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      if (redirectUri && redirectUri !== code.redirectUri)
        throw new InvalidGrantError("redirect_uri does not match");
      if (resource && !sameResource(resource.href, code.resource))
        throw new InvalidTargetError("resource does not match");
      if (!(await activeStaff(code.adminUser)))
        throw new InvalidGrantError("Staff account is not active");
      return issueTokens({
        clientId: code.clientId,
        adminUser: code.adminUser,
        grantId: code.grantId,
        scopes: code.scopes,
        resource: code.resource,
      });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const record = await store.findToken(sha256(refreshToken));
      if (
        !record ||
        record.kind !== "refresh" ||
        record.clientId !== client.client_id
      ) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      if (record.revokedAt || record.expiresAt <= now())
        throw new InvalidGrantError("Refresh token expired or revoked");
      if (record.rotatedAt || !(await store.rotateRefresh(record._id, now()))) {
        await store.revokeGrant(record.grantId, "refresh_reuse", now());
        throw new InvalidGrantError(
          "Refresh token was already used; sign in again",
        );
      }
      if (resource && !sameResource(resource.href, record.resource))
        throw new InvalidTargetError("resource does not match");
      const narrowed = scopes?.length ? scopes : record.scopes;
      if (narrowed.some((scope) => !record.scopes.includes(scope)))
        throw new InvalidScopeError("Cannot widen scopes on refresh");
      if (!(await activeStaff(record.adminUser))) {
        await store.revokeGrant(record.grantId, "staff_inactive", now());
        throw new InvalidGrantError("Staff account is not active");
      }
      return issueTokens({
        clientId: record.clientId,
        adminUser: record.adminUser,
        grantId: record.grantId,
        scopes: narrowed,
        resource: record.resource,
      });
    },

    async verifyAccessToken(accessToken) {
      if (
        typeof accessToken !== "string" ||
        !accessToken.startsWith("aqm_at_") ||
        accessToken.length > 100
      ) {
        throw new InvalidTokenError("Invalid access token");
      }
      const record = await store.findToken(sha256(accessToken));
      if (
        !record ||
        record.kind !== "access" ||
        record.revokedAt ||
        record.expiresAt <= now()
      ) {
        throw new InvalidTokenError("Invalid or expired access token");
      }
      const staff = await activeStaff(record.adminUser);
      if (!staff) throw new InvalidTokenError("Staff account is not active");
      const client = await store.getClient(record.clientId);
      if (!client)
        throw new InvalidTokenError("Client is no longer registered");
      if (
        !record.lastUsedAt ||
        now() - new Date(record.lastUsedAt) > 5 * 60000
      ) {
        store.touchToken(record._id, now()).catch(() => {});
      }
      return {
        token: accessToken,
        clientId: record.clientId,
        scopes: permittedScopes(staff, record.scopes),
        expiresAt: Math.floor(new Date(record.expiresAt).getTime() / 1000),
        resource: new URL(record.resource),
        extra: {
          adminUserId: String(staff._id),
          grantId: record.grantId,
          clientName: client.clientName,
        },
      };
    },

    async revokeToken(client, request) {
      const record = await store.findToken(sha256(request.token));
      // RFC 7009: unknown tokens are not an error.
      if (record && record.clientId === client.client_id) {
        await store.revokeGrant(record.grantId, "client_revoked", now());
      }
    },
  };
};
