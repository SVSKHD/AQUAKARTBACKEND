import mongoose from "mongoose";

const AquaCategorySchema = new mongoose.Schema(
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
    // MCP operation that created it (crash-safe retries); hidden.
    mcpOperation: { type: String, select: false },
  },
  {
    timestamps: true,
  },
);

const AquaCategory =
  mongoose.models.AquaCategory ||
  mongoose.model("AquaCategory", AquaCategorySchema);

export default AquaCategory;
