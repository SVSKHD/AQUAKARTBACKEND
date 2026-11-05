import mongoose from "mongoose";

// OAuth 2.1 state for the Aquakart MCP server (ChatGPT connector).
// Codes and tokens are stored as SHA-256 hashes only; the plaintext value
// exists once, in the response to the client. Clients are public (PKCE, no
// client secret) and limited to allowlisted redirect URIs.

const OAuthClientSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true },
    clientName: String,
    redirectUris: [String],
    // Registration metadata echoed back to the client (no secrets).
    metadata: mongoose.Schema.Types.Mixed,
    disabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// A validated /authorize request waiting for the staff member to sign in
// and approve on the consent page. Single use, 10 minutes.
const OAuthRequestSchema = new mongoose.Schema(
  {
    requestHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    scopes: [String],
    state: String,
    resource: String,
    consumedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
OAuthRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const OAuthCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    adminUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      required: true,
    },
    scopes: [String],
    codeChallenge: { type: String, required: true },
    redirectUri: { type: String, required: true },
    resource: String,
    grantId: { type: String, required: true },
    usedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
OAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

// Access and refresh tokens. All tokens issued from one consent share a
// grantId, so revoking (or detecting refresh-token reuse) ends the grant.
const OAuthTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["access", "refresh"], required: true },
    clientId: { type: String, required: true, index: true },
    adminUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      required: true,
      index: true,
    },
    grantId: { type: String, required: true, index: true },
    scopes: [String],
    resource: String,
    expiresAt: { type: Date, required: true },
    // Refresh tokens are single-use: set when exchanged for a new pair.
    rotatedAt: Date,
    revokedAt: Date,
    revokedReason: String,
    lastUsedAt: Date,
  },
  { timestamps: true },
);
OAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const McpOAuthClient =
  mongoose.models.AquaMcpOAuthClient ||
  mongoose.model("AquaMcpOAuthClient", OAuthClientSchema);
export const McpOAuthRequest =
  mongoose.models.AquaMcpOAuthRequest ||
  mongoose.model("AquaMcpOAuthRequest", OAuthRequestSchema);
export const McpOAuthCode =
  mongoose.models.AquaMcpOAuthCode ||
  mongoose.model("AquaMcpOAuthCode", OAuthCodeSchema);
export const McpOAuthToken =
  mongoose.models.AquaMcpOAuthToken ||
  mongoose.model("AquaMcpOAuthToken", OAuthTokenSchema);
