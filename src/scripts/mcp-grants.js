import "../../config.js";
import mongoose from "mongoose";
import AquaAdminUser from "../models/crm/adminUser.js";
import { randomUUID } from "node:crypto";
import { McpOAuthClient, McpOAuthToken } from "../models/mcp/oauth.js";
import { loadMcpConfig, redirectUriAllowed } from "../services/mcp/config.js";

// Lists or revokes MCP OAuth grants (ChatGPT/Claude connections). Never
// prints tokens (only hashes are stored anyway).
//   npm run mcp:grants -- list
//   npm run mcp:grants -- revoke <grantId>
//   npm run mcp:grants -- revoke-staff <email>
//   npm run mcp:grants -- disable-client <clientId>
//   npm run mcp:grants -- clients
//   npm run mcp:grants -- add-client <name> <redirectUri> [more redirectUris]
// add-client pre-registers a public PKCE client (no secret) for MCP clients
// whose automatic registration fails; paste the printed client id into the
// connector's "OAuth Client ID" field and leave the secret empty.

const [command, target, ...rest] = process.argv.slice(2);
const now = new Date();

await mongoose.connect(process.env.DB_URL);
try {
  if (command === "list") {
    const grants = await McpOAuthToken.aggregate([
      { $match: { revokedAt: null, expiresAt: { $gt: now } } },
      {
        $group: {
          _id: "$grantId",
          clientId: { $first: "$clientId" },
          adminUser: { $first: "$adminUser" },
          scopes: { $first: "$scopes" },
          lastUsedAt: { $max: "$lastUsedAt" },
          expiresAt: { $max: "$expiresAt" },
        },
      },
      { $sort: { lastUsedAt: -1 } },
    ]);
    const staff = new Map(
      (
        await AquaAdminUser.find({
          _id: { $in: grants.map((g) => g.adminUser) },
        })
          .select("email")
          .lean()
      ).map((s) => [String(s._id), s.email]),
    );
    const clients = new Map(
      (
        await McpOAuthClient.find({
          clientId: { $in: grants.map((g) => g.clientId) },
        })
          .select("clientId clientName")
          .lean()
      ).map((c) => [c.clientId, c.clientName]),
    );
    console.table(
      grants.map((g) => ({
        grantId: g._id,
        client: `${clients.get(g.clientId) || "?"} (${g.clientId})`,
        staff: staff.get(String(g.adminUser)) || String(g.adminUser),
        scopes: g.scopes.join(" "),
        lastUsedAt: g.lastUsedAt?.toISOString() || "-",
        refreshExpiresAt: g.expiresAt.toISOString(),
      })),
    );
  } else if (command === "revoke" && target) {
    const result = await McpOAuthToken.updateMany(
      { grantId: target, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: "admin_revoked" } },
    );
    console.log(`Revoked ${result.modifiedCount} token(s) of ${target}`);
  } else if (command === "revoke-staff" && target) {
    const staff = await AquaAdminUser.findOne({ email: target.toLowerCase() })
      .select("_id")
      .lean();
    if (!staff) throw new Error(`No staff account ${target}`);
    const result = await McpOAuthToken.updateMany(
      { adminUser: staff._id, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: "admin_revoked" } },
    );
    console.log(`Revoked ${result.modifiedCount} token(s) for ${target}`);
  } else if (command === "disable-client" && target) {
    await McpOAuthClient.updateOne(
      { clientId: target },
      { $set: { disabled: true } },
    );
    const result = await McpOAuthToken.updateMany(
      { clientId: target, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: "client_disabled" } },
    );
    console.log(
      `Disabled ${target} and revoked ${result.modifiedCount} token(s)`,
    );
  } else if (command === "clients") {
    const clients = await McpOAuthClient.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .select("clientId clientName redirectUris disabled createdAt")
      .lean();
    console.table(
      clients.map((c) => ({
        clientId: c.clientId,
        name: c.clientName,
        redirectUris: (c.redirectUris || []).join(" "),
        disabled: Boolean(c.disabled),
        createdAt: c.createdAt?.toISOString() || "-",
      })),
    );
  } else if (command === "add-client" && target && rest.length) {
    const config = loadMcpConfig(process.env);
    const refused = rest.filter((uri) => !redirectUriAllowed(uri, config));
    if (refused.length)
      throw new Error(
        `Redirect URI not on the allowlist: ${refused.join(", ")}`,
      );
    const client = await McpOAuthClient.create({
      clientId: `mcp_${randomUUID()}`,
      clientName: String(target).slice(0, 100),
      redirectUris: rest,
      metadata: { client_name: String(target).slice(0, 100) },
    });
    console.log(`Client ID: ${client.clientId}
(public PKCE client: leave the client secret empty)`);
  } else {
    console.log(
      "Usage: npm run mcp:grants -- list | clients | revoke <grantId> | revoke-staff <email> | disable-client <clientId> | add-client <name> <redirectUri> [...]",
    );
    process.exitCode = 1;
  }
} finally {
  await mongoose.disconnect();
}
