import mongoose from "mongoose";
import moment from "moment";
import AquaOrder from "../models/orders.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import sendEmail from "../notifications/email/send-email.js";
import orderEmail from "../utils/emailTemplates/orderEmail.js";
import {
  buildOrderCreatedNotification,
  publishCrmNotificationSafely,
} from "../services/crmNotifications.js";
import { buildCheckout, installationFrom } from "../services/checkout.js";

const ADMIN_PHONE = process.env.ADMIN_PHONE || "9014774667";

const formatCurrencyINR = (amount) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(amount);

const formattedDeliveryDate = (date) => moment(date).format("DD-MM-YYYY");

const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);
// Customers see only their own orders; admins see any.
const canSeeOrder = (order, req) =>
  Boolean(order) &&
  (req.isAdmin || sameId(order.user?._id ?? order.user, req.user?._id));

const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

const plainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Address maps hold strings only (schema: Map of String).
const addressFrom = (value, label) => {
  if (value === undefined || value === null) return undefined;
  if (!plainObject(value)) throw httpError(400, `${label} must be an object`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !key.startsWith("$") &&
          !key.includes(".") &&
          item !== null &&
          item !== undefined &&
          typeof item !== "object",
      )
      .map(([key, item]) => [key, String(item).slice(0, 300)]),
  );
};

const notesFrom = (value) =>
  value === undefined || value === null
    ? undefined
    : String(value).slice(0, 1000);

// Order fields for the legacy storefront routes (POST /v1/order/cod and
// /v1/order/pay). Only the product ids and quantities, addresses,
// installation slot, notes and order number come from the client; prices,
// totals and every status are computed here. Coupons are not applied on
// these routes (use /v1/checkout, which records redemptions).
export const legacyOrderFields = async (req, extra) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const quote = await buildCheckout({
    userId: req.user._id,
    cart: items.map((item) => ({
      productId: item?.productId?._id ?? item?.productId,
      quantity: item?.quantity ?? 1,
    })),
  });
  const requestedOrderId = String(req.body?.orderId || "");
  const shippingAddress = addressFrom(
    req.body?.shippingAddress,
    "shippingAddress",
  );
  return {
    user: req.user._id,
    orderId: /^[A-Za-z0-9_-]{4,40}$/.test(requestedOrderId)
      ? requestedOrderId
      : `AQOD-${Date.now()}`,
    items: quote.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      price: item.unitPrice,
      quantity: item.quantity,
    })),
    totalAmount: quote.payableAmount,
    discounts: quote.discount,
    taxes: quote.tax,
    shippingCost: quote.deliveryCharge,
    currency: quote.currency,
    shippingAddress,
    billingAddress:
      addressFrom(req.body?.billingAddress, "billingAddress") ||
      shippingAddress,
    shippingMethod: "Standard",
    estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    installation: installationFrom(req.body?.installation),
    notes: notesFrom(req.body?.notes),
    orderStatus: "Processing",
    ...extra,
  };
};

const getOrdersByUserId = async (req, res) => {
  const { id } = req.params;
  if (!sameId(id, req.user?._id))
    return res
      .status(403)
      .json({ success: false, message: "You can only view your own orders" });
  try {
    const orders = await AquaOrder.find({ user: req.user._id });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res.status(400).json({ success: false, message: "No orders found" });
  }
};

const getOrderByTransactionId = async (req, res) => {
  const { id } = req.params;
  try {
    // Only the caller's own order (null otherwise, as for an unknown id).
    const orders = await AquaOrder.findOne({
      transactionId: String(id),
      user: req.user._id,
    });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res.status(400).json({ success: false, message: "No orders found" });
  }
};

const getOrdersById = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res
      .status(400)
      .json({ success: false, message: "Invalid order id" });
  try {
    const orders = await AquaOrder.findById(id);
    // Someone else's order looks the same as a missing one.
    if (!canSeeOrder(orders, req))
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res.status(400).json({ success: false, message: "No orders found" });
  }
};

const getSingleOrderIdByUserId = async (req, res) => {
  const { userId, orderId } = req.params;
  try {
    const order = await AquaOrder.findOne({ user: userId, _id: orderId });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error retrieving order" });
  }
};

const getAllOrders = async (req, res) => {
  try {
    const orders = await AquaOrder.find();
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error retrieving orders" });
  }
};

const createOrder = async (req, res) => {
  try {
    const newOrder = new AquaOrder(req.body);
    const savedOrder = await newOrder.save();

    void publishCrmNotificationSafely(
      buildOrderCreatedNotification({
        order: savedOrder,
        source: "ecommerce",
      }),
    );

    return res.status(201).json({ success: true, data: savedOrder });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error creating order" });
  }
};

const updateOrder = async (req, res) => {
  const { id } = req.params;
  try {
    const updatedOrder = await AquaOrder.findByIdAndUpdate(id, req.body, {
      new: true,
    });
    if (!updatedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error updating order" });
  }
};

// PUT /v1/order/user/:id (customer). Own orders only; only cancelling and
// delivery details (shippingAddress, installation, notes), and only while the
// order is Pending or Processing. Other fields in the body (payment, totals,
// refund, invoice, items...) are ignored.
const CUSTOMER_EDITABLE_STATUSES = new Set(["Pending", "Processing"]);
const updateOwnOrder = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res
      .status(400)
      .json({ success: false, message: "Invalid order id" });
  try {
    const order = await AquaOrder.findById(id);
    if (!canSeeOrder(order, { user: req.user, isAdmin: false }))
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    const body = plainObject(req.body) ? req.body : {};
    const changes = {};
    const cancel =
      body.orderStatus === "Cancelled" ||
      body.orderCancelled === true ||
      body.orderCancelled === "true";
    if (cancel) {
      changes.orderStatus = "Cancelled";
      changes.orderCancelled = true;
      changes.orderCancelledDate = new Date().toISOString();
    }
    const shippingAddress = addressFrom(
      body.shippingAddress,
      "shippingAddress",
    );
    if (shippingAddress) changes.shippingAddress = shippingAddress;
    if (body.installation !== undefined) {
      const installation = installationFrom(body.installation);
      if (!installation)
        return res.status(400).json({
          success: false,
          message: "installation needs day (YYYY-MM-DD) and slot",
        });
      changes.installation = installation;
    }
    const notes = notesFrom(body.notes);
    if (notes !== undefined) changes.notes = notes;
    if (!Object.keys(changes).length)
      return res.status(400).json({
        success: false,
        message:
          "Nothing to update. Customers can cancel an order or change shippingAddress, installation or notes.",
      });
    if (!CUSTOMER_EDITABLE_STATUSES.has(order.orderStatus))
      return res.status(409).json({
        success: false,
        message: `This order is ${order.orderStatus} and can no longer be changed`,
      });
    // Conditional on the status, so a concurrent ship/cancel wins.
    const updatedOrder = await AquaOrder.findOneAndUpdate(
      {
        _id: id,
        user: req.user._id,
        orderStatus: { $in: [...CUSTOMER_EDITABLE_STATUSES] },
      },
      { $set: changes },
      { new: true, runValidators: true },
    );
    if (!updatedOrder)
      return res.status(409).json({
        success: false,
        message: "The order changed meanwhile; reload and try again",
      });
    return res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    if (error?.status === 400)
      return res.status(400).json({ success: false, message: error.message });
    console.error("Error updating own order:", error?.message || error);
    return res
      .status(400)
      .json({ success: false, message: "Error updating order" });
  }
};

const deleteOrder = async (req, res) => {
  const { id } = req.params;
  try {
    const deletedOrder = await AquaOrder.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, message: "Order deleted" });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error deleting order" });
  }
};

const createCodOrder = async (req, res) => {
  try {
    // The customer comes from the login token, not the body.
    const user = req.user;
    if (req.body?.user && !sameId(req.body.user, user._id))
      return res.status(403).json({
        success: false,
        message: "Orders can only be placed for your own account",
      });

    const orderCreated = await new AquaOrder(
      await legacyOrderFields(req, {
        orderType: "Cash On Delivery",
        paymentMethod: "Cash On Delivery",
        paymentStatus: "Pending",
        transactionId: `AQTR-COD-${Date.now()}`,
      }),
    ).save();

    void publishCrmNotificationSafely(
      buildOrderCreatedNotification({
        order: orderCreated,
        source: "cod",
        customerName: user.name || user.email || "",
      }),
    );

    const message = `Welcome to Aquakart Family, We have successfully received the order "${orderCreated.orderId}"`;
    const adminMessage = `New COD Order Received: Order ID "${orderCreated.orderId}" has been placed. Please process it accordingly.`;

    const notificationsPlanned = {
      email: Boolean(user.email),
      whatsapp: Boolean(user.phone),
      adminWhatsapp: Boolean(ADMIN_PHONE),
    };

    // Build notification jobs as lazy functions so we can send the response first
    const notificationJobs = [];

    if (user.phone) {
      notificationJobs.push(() =>
        sendWhatsAppMessage(user.phone, message).catch((err) =>
          console.error("Failed to send WhatsApp to user:", err),
        ),
      );
    }

    if (ADMIN_PHONE) {
      notificationJobs.push(() =>
        sendWhatsAppMessage(ADMIN_PHONE, adminMessage).catch((err) =>
          console.error("Failed to send WhatsApp to admin:", err),
        ),
      );
    }

    if (user.email) {
      notificationJobs.push(() =>
        (async () => {
          const priceInr = `${formatCurrencyINR(orderCreated.totalAmount)}/-`;
          const deliveryDate = formattedDeliveryDate(
            orderCreated.estimatedDelivery,
          );
          const content = orderEmail(
            orderCreated,
            user.email,
            priceInr,
            deliveryDate,
          );
          await sendEmail({
            email: user.email,
            subject: "Cash on Delivery Order Confirmation",
            message: "Cash on Delivery Order Confirmation - Hello Aquakart",
            content,
          });
        })().catch((err) =>
          console.error("Failed to send confirmation email:", err),
        ),
      );
    }

    // Fire-and-forget notifications after sending the response
    if (notificationJobs.length) {
      setImmediate(() => {
        Promise.allSettled(notificationJobs.map((job) => job())).catch((err) =>
          console.error("Notification dispatch encountered an error:", err),
        );
      });
    }

    return res.status(201).json({
      success: true,
      data: orderCreated,
      notificationsQueued: notificationJobs.length > 0,
      notificationsPlanned,
    });
  } catch (error) {
    // Cart/stock/address problems are the client's to fix.
    if (error?.status >= 400 && error?.status < 500)
      return res
        .status(error.status)
        .json({ success: false, message: error.message });
    console.error("Error creating COD order:", error);
    return res.status(500).json({
      success: false,
      message:
        "There was a problem creating the order, please try again later.",
    });
  }
};

const AdminGetOrders = async (req, res) => {
  try {
    const { id, transactionId, orderId, date, user } = req.params;

    // Construct the query object
    const query = {};
    if (id) query._id = mongoose.Types.ObjectId(id);
    if (transactionId) query.transactionId = transactionId;
    if (orderId) query.orderId = orderId;
    if (user) query.user = user;
    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      query.createdAt = {
        $gte: startDate,
        $lt: endDate,
      };
    }

    // Fetch orders based on the query
    const orders = await AquaOrder.find(query).populate("user items.productId");

    // Send the response
    res.status(200).json({
      count: orders?.length,
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const updateOrderByAdmin = async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  try {
    const updatedOrder = await AquaOrder.findByIdAndUpdate(id, updateData, {
      new: true,
    });
    if (!updatedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error updating order" });
  }
};

const deleteOrderByAdmin = async (req, res) => {
  const { id } = req.params;
  try {
    const deletedOrder = await AquaOrder.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res
      .status(200)
      .json({ success: true, message: "Order deleted successfully" });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error deleting order" });
  }
};

const OrderOperations = {
  getAllOrders,
  getSingleOrderIdByUserId,
  getOrdersByUserId,
  getOrdersById,
  getOrderByTransactionId,
  createOrder,
  updateOrder,
  deleteOrder,
  createCodOrder,
  updateOwnOrder,
  // admin routes
  AdminGetOrders,
  updateOrderByAdmin,
  deleteOrderByAdmin,
};

export default OrderOperations;
