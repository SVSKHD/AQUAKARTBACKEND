import mongoose from "mongoose";
import { SYSTEM_USER_ROLES } from "../constants/roles.js";

// Storefront account roles (admin, tester, user). Separate from the CRM's
// AquaRole, which carries staff permissions. See constants/roles.js.
const UserRoleSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    // Chats with the storefront assistant without the daily question limit.
    unlimitedAi: { type: Boolean, default: false },
    // The numeric AquaEcomUser.role kept in step with this role.
    legacyRole: { type: Number, required: true },
    // The role an account has when it points at none ("user").
    isDefault: { type: Boolean, default: false },
    // Built in: always present, never deleted.
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "aquauserroles" },
);

// Creates any missing system role; never overwrites an existing one, so a
// role edited in the database (e.g. a description) keeps its changes.
UserRoleSchema.statics.ensureDefaults = async function ensureDefaults() {
  await Promise.all(
    SYSTEM_USER_ROLES.map((role) =>
      this.updateOne(
        { slug: role.slug },
        { $setOnInsert: { ...role, isSystem: true, isActive: true } },
        { upsert: true },
      ),
    ),
  );
  return this.find({ isSystem: true }).sort({ legacyRole: 1 }).lean();
};

export default mongoose.models.AquaUserRole ||
  mongoose.model("AquaUserRole", UserRoleSchema);
