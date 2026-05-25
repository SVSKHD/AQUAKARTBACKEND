import mongoose from "mongoose";
import AquaOrder from "../../models/orders.js";
import AquaEcomUser from "../../models/user.js";

const ORDER_STATUS_MAP = {
  new: "Pending",
  pending: "Pending",
  confirmed: "Processing",
  processing: "Processing",
  packed: "Processing",
  shipped: "Shipped",
  out_for_delivery: "Shipped",
  completed: "Completed",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const PAYMENT_STATUS_MAP = {
  paid: "Paid",
  pending: "Pending",
  failed: "Failed",
  processing: "Processing",
  partial: "Pending",
  refunded: "Failed",
};

const getStartAndEndOfDay = (dateValue) => {
  const date = dateValue ? new Date(dateValue) : new Date();
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

const normalizeOrderStatus = (status) => {
  const key = String(status || "").toLowerCase();
  return ORDER_STATUS_MAP[key] || status;
};

const normalizePaymentStatus = (status) => {
  const key = String(status || "").toLowerCase();
  return PAYMENT_STATUS_MAP[key] || status;
};

const mapEcomOrderToCRMOrder = (order = {}) => {
  const user = order.user || {};
  const shippingAddress = order.shippingAddress || {};
  const billingAddress = order.billingAddress || {};
  const selectedAddress = user.selectedAddress || {};

  const addressParts = [
    shippingAddress.street || selectedAddress.street,
    shippingAddress.city || selectedAddress.city,
    shippingAddress.state || selectedAddress.state,
    shippingAddress.postalCode || selectedAddress.postalCode,
  ].filter(Boolean);

  const customerAddress =
    addressParts.join(", ") ||
    billingAddress.address ||
    shippingAddress.address ||
    selectedAddress.address ||
    "";

  const products = Array.isArray(order.items)
    ? order.items.map((item) => {
        const product = item.productId || {};
        const quantity = Number(item.quantity || 1);
        const unitPrice = Number(item.price || product.price || 0);
        return {
          productId: product._id || item.productId || null,
          productName: item.name || product.title || "Unknown Product",
          quantity,
          unitPrice,
          totalPrice: quantity * unitPrice,
          image: product.photos?.[0]?.secure_url || "",
        };
      })
    : [];

  const subtotal = products.reduce((sum, product) => sum + product.totalPrice, 0);
  const discount = Number(order.discounts || 0);
  const deliveryCharge = Number(order.shippingCost || 0);
  const grandTotal = Number(order.totalAmount || subtotal - discount + deliveryCharge);

  return {
    _id: order._id,
    sourceCollection: "AquaOrder",
    orderNumber: order.orderId || String(order._id || ""),
    orderDate: order.createdAt,
    deliveryDate: order.deliveryDate || order.estimatedDelivery || null,
    customer: {
      name: user.name || user.email || "Guest Customer",
      phone: String(user.phone || shippingAddress.phone || billingAddress.phone || ""),
      email: user.email || "",
      address: customerAddress,
      city: shippingAddress.city || selectedAddress.city || "",
      pincode: shippingAddress.postalCode || selectedAddress.postalCode || "",
      gstNumber: "",
    },
    products,
    subtotal,
    discount,
    deliveryCharge,
    grandTotal,
    paymentStatus: String(order.paymentStatus || "Pending").toLowerCase(),
    orderStatus: String(order.orderStatus || "Processing").toLowerCase(),
    rawOrderStatus: order.orderStatus,
    rawPaymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod || order.orderType || "",
    transactionId: order.transactionId || "",
    source: "website",
    invoiceId: null,
    notes: order.notes || "",
    raw: order,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
};

const buildQuery = async (queryParams = {}) => {
  const {
    id,
    transactionId,
    orderId,
    date,
    from,
    to,
    user,
    phone,
    search,
    orderStatus,
    status,
    paymentStatus,
  } = queryParams;

  const query = {};

  if (id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error("Invalid order id");
    }
    query._id = id;
  }

  if (transactionId) query.transactionId = transactionId;
  if (orderId) query.orderId = orderId;
  if (user) query.user = user;
  if (orderStatus || status) query.orderStatus = normalizeOrderStatus(orderStatus || status);
  if (paymentStatus) query.paymentStatus = normalizePaymentStatus(paymentStatus);

  if (date) {
    const { start, end } = getStartAndEndOfDay(date);
    query.createdAt = { $gte: start, $lte: end };
  } else if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = getStartAndEndOfDay(from).start;
    if (to) query.createdAt.$lte = getStartAndEndOfDay(to).end;
  }

  const userMatch = {};
  if (phone) userMatch.phone = { $regex: phone, $options: "i" };

  if (search) {
    const regex = { $regex: search, $options: "i" };
    query.$or = [
      { orderId: regex },
      { transactionId: regex },
      { "items.name": regex },
      { paymentMethod: regex },
      { orderType: regex },
    ];

    userMatch.$or = [{ name: regex }, { email: regex }, { phone: regex }];
  }

  if (Object.keys(userMatch).length) {
    const matchedUsers = await AquaEcomUser.find(userMatch).select("_id").lean();
    const matchedUserIds = matchedUsers.map((matchedUser) => matchedUser._id);
    if (matchedUserIds.length) {
      query.$or = [...(query.$or || []), { user: { $in: matchedUserIds } }];
    }
  }

  return query;
};

const getOrders = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const skip = (page - 1) * limit;
    const query = await buildQuery(req.query);

    const [orders, total] = await Promise.all([
      AquaOrder.find(query)
        .populate("user items.productId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaOrder.countDocuments(query),
    ]);

    const mappedOrders = orders.map(mapEcomOrderToCRMOrder);

    return res.status(200).json({
      status: true,
      success: true,
      sourceCollection: "AquaOrder",
      data: mappedOrders,
      rawCount: orders.length,
      no: mappedOrders.length,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get CRM ecommerce orders error:", error);
    return res.status(500).json({
      status: false,
      success: false,
      message: error.message || "Failed to fetch ecommerce orders",
    });
  }
};

const getTodayOrders = async (req, res) => {
  req.query.date = new Date().toISOString();
  return getOrders(req, res);
};

const getTomorrowOrders = async (req, res) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  req.query.date = tomorrow.toISOString();
  return getOrders(req, res);
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: false, message: "Invalid order id" });
    }

    const order = await AquaOrder.findById(id).populate("user items.productId").lean();
    if (!order) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }

    return res.status(200).json({
      status: true,
      success: true,
      sourceCollection: "AquaOrder",
      data: mapEcomOrderToCRMOrder(order),
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      success: false,
      message: "Failed to fetch order",
      error: error.message,
    });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { orderStatus, paymentStatus, notes, deliveryDate } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: false, message: "Invalid order id" });
    }

    const updatePayload = {};
    if (orderStatus) updatePayload.orderStatus = normalizeOrderStatus(orderStatus);
    if (paymentStatus) updatePayload.paymentStatus = normalizePaymentStatus(paymentStatus);
    if (notes !== undefined) updatePayload.notes = notes;
    if (deliveryDate !== undefined) updatePayload.deliveryDate = deliveryDate || null;

    if (!Object.keys(updatePayload).length) {
      return res.status(400).json({
        status: false,
        message: "orderStatus, paymentStatus, notes or deliveryDate is required",
      });
    }

    const order = await AquaOrder.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    })
      .populate("user items.productId")
      .lean();

    if (!order) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }

    return res.status(200).json({
      status: true,
      success: true,
      message: "Order updated successfully",
      data: mapEcomOrderToCRMOrder(order),
    });
  } catch (error) {
    console.error("Update CRM ecommerce order error:", error);
    return res.status(500).json({
      status: false,
      success: false,
      message: "Failed to update order",
      error: error.message,
    });
  }
};

const CRMEcommerceOrderOperations = {
  getOrders,
  getTodayOrders,
  getTomorrowOrders,
  getOrderById,
  updateOrderStatus,
};

export default CRMEcommerceOrderOperations;
