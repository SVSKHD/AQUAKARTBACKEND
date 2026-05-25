import mongoose from "mongoose";
import { nanoid } from "nanoid";
import AquaInvoice from "../../models/crm/invoice.js";
import AquaOrder from "../../models/orders.js";

const normalizeIndianPhone = (phone) =>
  String(phone || "")
    .replace(/\s|-/g, "")
    .replace(/^\+91/, "")
    .replace(/^91/, "");

const getProductSlug = (product = {}) =>
  product.slug || product.seoSlug || product.ShortName || product.code || "";

const buildProductLink = (slug) =>
  slug ? `https://aquakart.co.in/product/${slug}` : "";

const buildInvoiceNo = () => {
  const uniqueId = nanoid(10);
  const now = new Date();
  return `AQB${uniqueId}|${now.getDate()}${now.getMonth() + 1}${now.getFullYear()}`;
};

const mapOrderToInvoicePayload = (order) => {
  const user = order.user || {};
  const shippingAddress = order.shippingAddress || {};
  const billingAddress = order.billingAddress || {};
  const selectedAddress = user.selectedAddress || {};

  const customerAddress =
    [
      shippingAddress.street || shippingAddress.address || selectedAddress.street,
      shippingAddress.city || selectedAddress.city,
      shippingAddress.state || selectedAddress.state,
      shippingAddress.postalCode || selectedAddress.postalCode,
    ]
      .filter(Boolean)
      .join(", ") ||
    billingAddress.address ||
    selectedAddress.address ||
    "";

  const products = (order.items || []).map((item) => {
    const product = item.productId || {};
    const productSlug = getProductSlug(product);
    return {
      productName: item.name || product.title || "Unknown Product",
      productQuantity: Number(item.quantity || 1),
      productPrice: Number(item.price || product.price || 0),
      productSerialNo: "",
      productId: product._id || item.productId || null,
      productSlug,
      productLink: buildProductLink(productSlug),
    };
  });

  const now = new Date();
  const formattedDate = now.toISOString().split("T")[0];
  const deliveryDate = order.deliveryDate || order.estimatedDelivery;

  return {
    invoiceNo: buildInvoiceNo(),
    date: formattedDate,
    customerDetails: {
      name: user.name || user.email || "Aquakart Online Customer",
      phone: Number(normalizeIndianPhone(user.phone || shippingAddress.phone || billingAddress.phone || 0)),
      email: user.email || "",
      address: customerAddress,
    },
    gst: false,
    po: false,
    quotation: false,
    gstDetails: {},
    products,
    transport: {
      deliveredBy: "Aquakart",
      deliveryDate: deliveryDate
        ? new Date(deliveryDate).toISOString().split("T")[0]
        : formattedDate,
    },
    paidStatus: String(order.paymentStatus || "Pending"),
    aquakartOnlineUser: true,
    aquakartInvoice: true,
    sourceOrderId: order._id,
    sourceOrderNo: order.orderId || String(order._id),
    sourceOrderCollection: "AquaOrder",
    productId: products[0]?.productId || null,
    paymentType: order.paymentMethod || order.orderType || "Online Order",
  };
};

const createInvoiceFromEcommerceOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        status: false,
        success: false,
        message: "Invalid order id",
      });
    }

    const existingOrder = await AquaOrder.findById(orderId)
      .populate("user items.productId")
      .lean();

    if (!existingOrder) {
      return res.status(404).json({
        status: false,
        success: false,
        message: "Order not found",
      });
    }

    if (existingOrder.invoiceId) {
      const existingInvoice = await AquaInvoice.findById(existingOrder.invoiceId).lean();
      if (existingInvoice) {
        return res.status(200).json({
          status: true,
          success: true,
          alreadyCreated: true,
          message: "Invoice already created for this order",
          data: existingInvoice,
          invoiceId: existingInvoice._id,
          invoiceUrl: `https://admin.aquakart.co.in/invoice/${existingInvoice._id}`,
        });
      }
    }

    const existingInvoiceBySource = await AquaInvoice.findOne({
      sourceOrderId: orderId,
      sourceOrderCollection: "AquaOrder",
    }).lean();

    if (existingInvoiceBySource) {
      await AquaOrder.findByIdAndUpdate(orderId, {
        invoiceId: existingInvoiceBySource._id,
        aquakartOnlineUser: true,
        invoiceCreatedAt: existingOrder.invoiceCreatedAt || new Date(),
      });

      return res.status(200).json({
        status: true,
        success: true,
        alreadyCreated: true,
        message: "Invoice already created for this order",
        data: existingInvoiceBySource,
        invoiceId: existingInvoiceBySource._id,
        invoiceUrl: `https://admin.aquakart.co.in/invoice/${existingInvoiceBySource._id}`,
      });
    }

    const invoicePayload = mapOrderToInvoicePayload(existingOrder);
    const savedInvoice = await new AquaInvoice(invoicePayload).save();

    await AquaOrder.findByIdAndUpdate(orderId, {
      invoiceId: savedInvoice._id,
      aquakartOnlineUser: true,
      invoiceCreatedAt: new Date(),
    });

    return res.status(201).json({
      status: true,
      success: true,
      alreadyCreated: false,
      message: "Invoice created from order successfully",
      data: savedInvoice,
      invoiceId: savedInvoice._id,
      invoiceUrl: `https://admin.aquakart.co.in/invoice/${savedInvoice._id}`,
    });
  } catch (error) {
    console.error("Create invoice from ecommerce order error:", error);
    return res.status(500).json({
      status: false,
      success: false,
      message: "Failed to create invoice from order",
      error: error.message,
    });
  }
};

export default {
  createInvoiceFromEcommerceOrder,
};
