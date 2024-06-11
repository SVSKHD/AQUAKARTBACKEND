import mongoose from "mongoose";
import AquaCategory from "./category";

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
  },
  {
    timestamps: true,
  },
);

const AquaSubCategory =
  mongoose.models.AquaSubCategory ||
  mongoose.model("AquaSubCategory", AquaSubCategorySchema);

export default AquaSubCategory;
