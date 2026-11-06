import mongoose from "mongoose";

const AquaSubCategorySchema = new mongoose.Schema(
  {
    title: {
      type: String,
    },
    description: {
      type: String,
    },
    photos: [
      {
        id: String,
        secure_url: String,
      },
    ],
    keywords: {
      type: String,
    },
    category: {
      type: mongoose.Schema.ObjectId,
      ref: "AquaCategory",
      required: true,
    },
    // MCP operation that created it (crash-safe retries); hidden.
    mcpOperation: { type: String, select: false },
  },
  {
    timestamps: true,
  },
);

const AquaSubCategory =
  mongoose.models.AquaSubCategory ||
  mongoose.model("AquaSubCategory", AquaSubCategorySchema);

export default AquaSubCategory;
