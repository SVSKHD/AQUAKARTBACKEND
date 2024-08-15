import mongoose from "mongoose";

const AquaEmailSubscriptionSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    match: [/\S+@\S+\.\S+/, "is invalid"],
  },
  subscribedAt: {
    type: Date,
    default: Date.now,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  subscriptionStatus: {
    type: String,
    enum: ["active", "unsubscribed"],
    default: "active",
  },
});

const AquaEmailSubscription = mongoose.model(
  "AquaEmailSubscription",
  AquaEmailSubscriptionSchema,
);

export default AquaEmailSubscription;
