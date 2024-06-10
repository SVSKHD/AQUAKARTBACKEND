import mongoose from "mongoose";

const BlogSchema = new mongoose.Schema({
  titleImages: [
    {
      id: {
        type: String,
        required: true,
      },
      secure_url: {
        type: String,
        required: true,
      },
    },
  ],
  title: {
    type: String,
    required: [true, "please provide product name"],
    trim: true,
    maxlength: [120, "Product name should not be more than 120 characters"],
  },
  description: {
    type: String,
    required: [true, "please provide product description"],
  },
  keywords: {
    type: String,
  },
  notes: {
    type: String,
    maxlength: [300, "Product Notes must not exceed 300"],
  },
  photos: [
    {
      id: {
        type: String,
        required: true,
      },
      secure_url: {
        type: String,
        required: true,
      },
    },
  ],
  category: {
    type: mongoose.Schema.ObjectId,
    ref: "AquaCategory",
  },
  subCategory: {
    type: mongoose.Schema.ObjectId,
    ref: "AquaSubCategory",
  },
  product: {
    type: mongoose.Schema.ObjectId,
    ref: "AquaProduct",
  },
  brand: {
    type: String,
    required: [true, "please add a brand for clothing"],
  },
  ratings: {
    type: Number,
    default: 0,
  },
  numberOfReviews: {
    type: Number,
    default: 0,
  },
  product: {
    type: mongoose.Schema.ObjectId,
    ref: "AquaProduct",
  },
  reviews: [
    {
      user: {
        type: mongoose.Schema.ObjectId,
        ref: "User",
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
      rating: {
        type: Number,
        required: true,
      },
      comment: {
        type: String,
        required: true,
      },
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports =
  mongoose.models.AquaBlog || mongoose.model("AquaBlog", BlogSchema);