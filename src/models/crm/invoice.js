import mongoose, { ObjectId } from "mongoose";

const AquaInvoiceSchema = new mongoose.Schema(
  {
    invoiceNo: {
      type: String,
    },
    date: {
      type: String,
    },
    customerDetails: {
      name: {
        type: String,
      },
      phone: {
        type: Number,
      },
      email: {
        type: String,
      },
      address: {
        type: String,
      },
    },
    gst: {
      type: Boolean,
      default: false,
    },
    po: {
      type: Boolean,
      default: false,
    },
    quotation: {
      type: Boolean,
      default: false,
    },
    gstDetails: {
      gstName: {
        type: String,
      },
      gstNo: {
        type: String,
      },
      gstPhone: {
        type: Number,
      },
      gstEmail: {
        type: String,
      },
      gstAddress: {
        type: String,
      },
    },
    products: [
      {
        productName: {
          type: String,
        },
        productQuantity: {
          type: Number,
        },
        productPrice: {
          type: Number,
        },
        productDiscount: {
          type: Number,
          default: 0,
        },
        productTax: {
          type: Number,
          default: 0,
        },
        productTotal: {
          type: Number,
          default: 0,
        },
        productSerialNo: {
          type: String,
        },
        productId: {
          type: ObjectId,
          ref: "AquaProduct",
        },
        productSlug: {
          type: String,
        },
        productLink: {
          type: String,
        },
      },
    ],
    subTotal: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    tax: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      default: 0,
    },
    transport: {
      deliveredBy: {
        type: String,
      },
      deliveryDate: {
        type: String,
      },
    },
    review: {
      type: String,
    },
    paidStatus: {
      type: String,
    },
    aquakartOnlineUser: {
      type: Boolean,
      default: false,
    },
    aquakartInvoice: {
      type: Boolean,
      default: false,
    },
    sourceOrderId: {
      type: ObjectId,
      ref: "AquaOrder",
      default: null,
      index: true,
    },
    sourceOrderNo: {
      type: String,
    },
    sourceOrderCollection: {
      type: String,
      enum: ["AquaOrder", "AquaCRMOrder", "AquaQuotation", "manual"],
      default: "manual",
    },
    sourceQuotationId: {
      type: ObjectId,
      ref: "AquaQuotation",
      default: null,
      index: true,
    },
    sourceQuotationNo: {
      type: String,
    },
    productId: {
      type: ObjectId,
      ref: "AquaProduct",
    },
    paymentType: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

const AquaInvoice =
  mongoose.models.AquaInvoice ||
  mongoose.model("AquaInvoice", AquaInvoiceSchema);

export default AquaInvoice;
