import mongoose from "mongoose";
import { PERMISSIONS, SUPER_ADMIN_ROLE } from "../../constants/permissions.js";

const RoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: { type: String, trim: true, default: "" },
    permissions: [{ type: String, enum: PERMISSIONS }],
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true },
);

RoleSchema.pre("validate", function normalizeSlug() {
  if (this.slug)
    this.slug = this.slug.toLowerCase().trim().replace(/\s+/g, "-");
});

RoleSchema.methods.hasPermission = function hasPermission(permission) {
  return (
    this.slug === SUPER_ADMIN_ROLE || this.permissions.includes(permission)
  );
};

export default mongoose.models.AquaRole ||
  mongoose.model("AquaRole", RoleSchema);
