import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const OrderItemSchema = new mongoose.Schema({
  productId: {
    type: ObjectId,
    ref: "AquaProduct",
  },
  name: String,
  price: Number,
  quantity: Number,
});

const OrderSchema = new mongoose.Schema(
  {
    user: {
      type: ObjectId,
      ref: "AquaEcomUser", // Assuming you have a User model
      required: true,
    },
    orderId: { type: String },
    orderType: {
      type: String,
      enum: [
        "Cash On Delivery",
        "Payment Method(Phone Pe Gateway)",
        "Payment Method Gateway",
        "Payment Method Razorpay",
        "Payment Method",
      ], // Allowed values
      required: true, // Making this field required; adjust as necessary
    },
    transactionId: { type: String },
    items: [OrderItemSchema],
    totalAmount: Number,
    paymentMethod: String,
    transactionId: String,
    paymentStatus: {
      type: String,
      enum: ["Paid", "Pending", "Failed", "Processing"],
      default: "Processing",
    },
    paymentGatewayDetails: {
      type: Map,
      of: mongoose.Schema.Types.Mixed, // Allows for flexible data types within the Map
    },
    paymentInstrument: {
      type: Map,
      of: mongoose.Schema.Types.Mixed, // Allows for flexible data types within the Map
    },
    currency: String,
    billingAddress: {
      type: Map,
      of: String,
    },
    shippingAddress: {
      type: Map,
      of: String,
    },
    shippingMethod: String,
    shippingCost: Number,
    estimatedDelivery: Date,
    isOderDelivery: {
      type: Boolean,
    },
    isOrderDeliveryDate: {
      type: String,
    },
    orderRefund: {
      type: Boolean,
    },
    orderRefundDate: {
      type: String,
    },
    orderCancelled: {
      type: Boolean,
    },
    orderCancelledDate: {
      type: String,
    },
    orderStatus: {
      type: String,
      enum: ["Pending", "Processing", "Shipped", "Completed", "Cancelled"],
      default: "Processing",
    },
    discounts: Number,
    taxes: Number,
    notes: String,
    gst: Number,
    paymentGatewayResponse: {
      type: Map,
      of: String,
    },
    refundInfo: {
      type: Map,
      of: String,
    },
    offerApplied: {
      type: Boolean,
      default: false, // Assuming default value is false
    },
    offerAppliedDetails: {
      code: { type: String },
      validity: { type: Date },
    },
  },
  {
    timestamps: true,
  },
);

const AquaOrder =
  mongoose.models.AquaOrder || mongoose.model("AquaOrder", OrderSchema);

export default AquaOrder;
