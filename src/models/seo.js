import mongoose from "mongoose";

const SeoSchema = new mongoose.Schema(
  {
    pageKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    },
    route: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    keywords: {
      type: [{ type: String, trim: true, maxlength: 100 }],
      default: [],
      validate: {
        validator: (value) => value.length <= 50,
        message: "A maximum of 50 keywords is allowed",
      },
    },
    canonicalUrl: { type: String, trim: true, default: "", maxlength: 1000 },
    robots: {
      type: String,
      trim: true,
      default: "index,follow",
      maxlength: 100,
    },
    ogTitle: { type: String, trim: true, default: "", maxlength: 120 },
    ogDescription: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    ogImage: { type: String, trim: true, default: "", maxlength: 1000 },
    twitterTitle: { type: String, trim: true, default: "", maxlength: 120 },
    twitterDescription: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    twitterImage: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
    schemaJson: { type: mongoose.Schema.Types.Mixed, default: null },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true },
);

SeoSchema.index({ active: 1, pageKey: 1 });

export default mongoose.models.AquaSeo || mongoose.model("AquaSeo", SeoSchema);
