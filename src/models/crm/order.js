import mongoose from "mongoose";

const CRM_ORDER_STATUSES = [
  "new",
  "confirmed",
  "packed",
  "out_for_delivery",
  "delivered",
  "cancelled",
];

const CRM_PAYMENT_STATUSES = ["pending", "partial", "paid", "refunded"];

const CRM_ORDER_SOURCES = ["crm", "telegram", "whatsapp", "website", "manual"];

const crmOrderProductSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.ObjectId,
      ref: "AquaProduct",
      default: null,
    },
    productName: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
    },
    quantity: {
      type: Number,
      required: [true, "Product quantity is required"],
      min: [1, "Product quantity must be at least 1"],
    },
    unitPrice: {
      type: Number,
      required: [true, "Product unit price is required"],
      min: [0, "Product unit price must be at least 0"],
    },
    totalPrice: {
      type: Number,
      required: [true, "Product total price is required"],
      min: [0, "Product total price must be at least 0"],
    },
  },
  { _id: false },
);

const crmOrderCustomerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Customer phone is required"],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      required: [true, "Customer address is required"],
      trim: true,
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    pincode: {
      type: String,
      trim: true,
      default: "",
    },
    gstNumber: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false },
);

const crmOrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      index: true,
    },
    orderDate: {
      type: Date,
      required: [true, "Order date is required"],
      index: true,
    },
    deliveryDate: {
      type: Date,
      default: null,
      index: true,
    },
    customer: {
      type: crmOrderCustomerSchema,
      required: true,
    },
    products: {
      type: [crmOrderProductSchema],
      required: true,
      validate: {
        validator(products) {
          return Array.isArray(products) && products.length > 0;
        },
        message: "At least one product is required",
      },
    },
    subtotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveryCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    grandTotal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    paymentStatus: {
      type: String,
      enum: CRM_PAYMENT_STATUSES,
      default: "pending",
      index: true,
    },
    orderStatus: {
      type: String,
      enum: CRM_ORDER_STATUSES,
      default: "new",
      index: true,
    },
    source: {
      type: String,
      enum: CRM_ORDER_SOURCES,
      default: "crm",
    },
    invoiceId: {
      type: mongoose.Schema.ObjectId,
      ref: "AquaInvoice",
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.ObjectId,
      ref: "AquaAdminUser",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

crmOrderSchema.index({ orderDate: -1, createdAt: -1 });
crmOrderSchema.index({ "customer.phone": 1 });
crmOrderSchema.index({ "customer.name": "text", orderNumber: "text" });

const AquaCRMOrder =
  mongoose.models.AquaCRMOrder ||
  mongoose.model("AquaCRMOrder", crmOrderSchema);

export {
  CRM_ORDER_STATUSES,
  CRM_PAYMENT_STATUSES,
  CRM_ORDER_SOURCES,
};

export default AquaCRMOrder;
