import mongoose from "mongoose";

const aquaUserActivitySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "AquaEcomUser",
    required: true,
  },
  activityType: {
    type: String,
    required: true,
    enum: [
      "login",
      "logout",
      "viewProduct",
      "addToCart",
      "removeFromCart",
      "placeOrder",
      "updateProfile",
      "resetPassword",
      "wishlist",
      "removeFromWishlist",
    ],
  },
  activityDate: {
    type: Date,
    default: Date.now,
  },
});

const AquaUserActivity =
  mongoose.models.AquaUserActivity ||
  mongoose.model("AquaUserActivity", aquaUserActivitySchema);

export default AquaUserActivity;
