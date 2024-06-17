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
        productSerialNo: {
          type: String,
        },
      },
    ],
    transport: {
      deliveredBy: {
        type: String,
      },
      deliveryDate: {
        type: String,
      },
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
