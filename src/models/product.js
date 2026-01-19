import mongoose, { ObjectId } from "mongoose";

const AquaProductSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, "please provide product name"],
    trim: true,
    maxlength: [120, "Product name should not be more than 120 characters"],
  },
  ShortName: {
    type: String,
  },
  slug: {
    type: String,
  },
  seoSlug: {
    type: String,
  },
  code: {
    type: String,
  },
  discountPriceStatus: {
    type: Boolean,
    default: false,
  },
  discountPricePercentage: {
    type: Number,
  },
  discountPrice: {
    type: Number,
  },
  keywords: {
    type: String,
  },
  price: {
    type: Number,
    required: [true, "please provide product price"],
    maxlength: [6, "Product price should not be more than 6 digits"],
  },
  description: {
    type: String,
    required: [true, "please provide product description"],
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
  arPhotos: [
    {
      id: {
        type: String,
        required: true,
      },
      secure_url: {
        type: String,
        required: true,
      },
      delivery_url: {
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
  blog: {
    type: mongoose.Schema.ObjectId,
    ref: "AquaBlog",
  },
  //this field was updated in order videos later
  stock: {
    type: Number,
    required: [true, "please add a number in stock"],
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
  dpPrice: {
    type: Number,
    default: 0,
  },
  reviews: [
    {
      user: {
        type: mongoose.Schema.ObjectId,
        ref: "User",
      },
      name: {
        type: String,
      },
      rating: {
        type: Number,
      },
      comment: {
        type: String,
      },
    },
  ],
  user: {
    type: mongoose.Schema.ObjectId,
    ref: "User",
  },
  createdAt: {
    type: Date,
    default: Date.now(),
  },
});

const AquaProduct =
  mongoose.models.AquaProduct ||
  mongoose.model("AquaProduct", AquaProductSchema);

export default AquaProduct;
