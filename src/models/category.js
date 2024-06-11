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
  },
  {
    timestamps: true,
  },
);

const AquaCategory =
  mongoose.models.AquaCategory ||
  mongoose.model("AquaCategory", AquaCategorySchema);

export default AquaCategory;
