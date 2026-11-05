import "../../config.js";
import mongoose from "mongoose";
import AquaAdminUser from "../models/crm/adminUser.js";
import { McpOAuthClient, McpOAuthToken } from "../models/mcp/oauth.js";

// Lists or revokes MCP OAuth grants (ChatGPT/Claude connections). Never
// prints tokens (only hashes are stored anyway).
//   npm run mcp:grants -- list
//   npm run mcp:grants -- revoke <grantId>
//   npm run mcp:grants -- revoke-staff <email>
//   npm run mcp:grants -- disable-client <clientId>

const [command, target] = process.argv.slice(2);
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
  } else {
    console.log(
      "Usage: npm run mcp:grants -- list | revoke <grantId> | revoke-staff <email> | disable-client <clientId>",
    );
    process.exitCode = 1;
  }
} finally {
  await mongoose.disconnect();
}
