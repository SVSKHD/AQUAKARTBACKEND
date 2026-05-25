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
      ref: "AquaEcomUser",
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
      ],
      required: true,
    },
    transactionId: { type: String },
    items: [OrderItemSchema],
    totalAmount: Number,
    paymentMethod: String,
    paymentStatus: {
      type: String,
      enum: ["Paid", "Pending", "Failed", "Processing"],
      default: "Processing",
    },
    paymentGatewayDetails: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
    },
    paymentInstrument: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
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
    isOrderDelivery: {
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
      enum: [
        "Pending",
        "Processing",
        "Shipped",
        "Completed",
        "Cancelled",
        "Delivered",
      ],
      default: "Processing",
    },
    refund: {
      type: Boolean,
      default: false,
    },
    refundStatus: {
      type: String,
      enum: ["Not Initiated", "Initiated", "Processing", "Completed", "Failed"],
      default: "Not Initiated",
    },
    deliveryDate: Date,
    discounts: Number,
    taxes: Number,
    notes: String,
    gst: Number,
    invoiceId: {
      type: ObjectId,
      ref: "AquaInvoice",
      default: null,
    },
    aquakartOnlineUser: {
      type: Boolean,
      default: false,
    },
    invoiceCreatedAt: {
      type: Date,
      default: null,
    },
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
      default: false,
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
