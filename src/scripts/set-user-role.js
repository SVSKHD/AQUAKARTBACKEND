// Storefront roles on whichever database DB_URL points at (run it against
// production and against development).
//
//   npm run role -- list                          the roles and who has them
//   npm run role -- tester someone@example.com    make an account a tester
//   npm run role -- admin  someone@example.com
//   npm run role -- user   someone@example.com    back to the default
//
// The roles collection (admin, tester, user) is created if it's missing.
// Admins and testers chat with the storefront assistant without a daily limit.
import "../../config.js";
import mongoose from "mongoose";
import AquaEcomUser from "../models/user.js";
import UserRole from "../models/userRole.js";
import { DEFAULT_USER_ROLE, userRoleSlug } from "../constants/roles.js";

// "customer" is accepted for "user".
const ALIASES = { customer: DEFAULT_USER_ROLE };

const [command, rawEmail] = process.argv.slice(2);
const wanted = String(command || "").toLowerCase();
const slug = ALIASES[wanted] || wanted;
const email = String(rawEmail || "")
  .trim()
  .toLowerCase();

if (!slug || (slug !== "list" && !email)) {
  console.error(
    "Usage: npm run role -- list\n       npm run role -- <admin|tester|user> <email>",
  );
  process.exit(1);
}
if (!process.env.DB_URL) throw new Error("DB_URL is required.");

await mongoose.connect(process.env.DB_URL);
try {
  const roles = await UserRole.ensureDefaults();

  if (slug === "list") {
    for (const role of roles) {
      // Accounts not linked to a role are users.
      const filter = role.isDefault
        ? { $or: [{ roleRef: role._id }, { roleRef: null }] }
        : { roleRef: role._id };
      const count = await AquaEcomUser.countDocuments(filter);
      const people = role.isDefault
        ? []
        : await AquaEcomUser.find(filter).select("email").limit(20).lean();
      console.log(
        `${role.slug.padEnd(7)} ${String(count).padStart(6)} account(s)` +
          `${role.unlimitedAi ? "  · unlimited AI chats" : ""}`,
      );
      for (const p of people) console.log(`          ${p.email}`);
    }
  } else {
    const role = roles.find((r) => r.slug === slug);
    if (!role) {
      console.error(
        `Unknown role "${slug}". Roles: ${roles.map((r) => r.slug).join(", ")}`,
      );
      process.exitCode = 1;
    } else {
      const user = await AquaEcomUser.findOne({ email }).populate("roleRef");
      if (!user) {
        console.error(
          `No account with the email ${email}. They sign in once first.`,
        );
        process.exitCode = 1;
      } else {
        const before = userRoleSlug(user);
        // Only the role fields: no full-document validation of older accounts.
        await AquaEcomUser.updateOne(
          { _id: user._id },
          { $set: { roleRef: role._id, role: role.legacyRole } },
        );
        console.log(`${email}: ${before} → ${role.slug}`);
        console.log(
          "It applies straight away: the server reads the role on every request.",
        );
      }
    }
  }
} finally {
  await mongoose.disconnect();
}
