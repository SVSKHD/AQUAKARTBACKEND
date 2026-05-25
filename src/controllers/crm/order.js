import mongoose from "mongoose";
import AquaCRMOrder, {
  CRM_ORDER_STATUSES,
  CRM_PAYMENT_STATUSES,
  CRM_ORDER_SOURCES,
} from "../../models/crm/order.js";

const INDIAN_CONTACT_REGEX = /^(?:\+91|91)?[6-9]\d{9}$/;

const normalizeIndianPhone = (phone) =>
  String(phone || "")
    .replace(/\s|-/g, "")
    .replace(/^\+91/, "")
    .replace(/^91/, "");

const getStartAndEndOfDay = (dateValue) => {
  const date = dateValue ? new Date(dateValue) : new Date();
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

const formatDateKey = (dateValue) => {
  const date = new Date(dateValue);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}${mm}${dd}`;
};

const generateOrderNumber = async (orderDate) => {
  const dateKey = formatDateKey(orderDate);
  const { start, end } = getStartAndEndOfDay(orderDate);

  const count = await AquaCRMOrder.countDocuments({
    orderDate: { $gte: start, $lte: end },
  });

  return `AK-ORD-${dateKey}-${String(count + 1).padStart(3, "0")}`;
};

const buildOrderTotals = (products = [], discount = 0, deliveryCharge = 0) => {
  const normalizedProducts = products.map((product) => {
    const quantity = Number(product.quantity || 1);
    const unitPrice = Number(product.unitPrice || product.price || 0);

    return {
      productId: product.productId || null,
      productName: String(product.productName || product.name || "").trim(),
      quantity,
      unitPrice,
      totalPrice: quantity * unitPrice,
    };
  });

  const subtotal = normalizedProducts.reduce(
    (total, product) => total + product.totalPrice,
    0,
  );

  const safeDiscount = Number(discount || 0);
  const safeDeliveryCharge = Number(deliveryCharge || 0);
  const grandTotal = subtotal - safeDiscount + safeDeliveryCharge;

  return {
    normalizedProducts,
    subtotal,
    discount: safeDiscount,
    deliveryCharge: safeDeliveryCharge,
    grandTotal,
  };
};

const validateOrderPayload = (payload = {}, { partial = false } = {}) => {
  const errors = {};
  const customer = payload.customer || {};
  const products = payload.products;

  if (!partial || payload.customer !== undefined) {
    if (!customer.name || !String(customer.name).trim())
      errors["customer.name"] = "Customer name is required";

    if (!customer.phone || !String(customer.phone).trim()) {
      errors["customer.phone"] = "Customer phone is required";
    } else if (!INDIAN_CONTACT_REGEX.test(String(customer.phone).replace(/\s|-/g, ""))) {
      errors["customer.phone"] = "Customer phone must be a valid Indian contact number";
    }

    if (!customer.address || !String(customer.address).trim())
      errors["customer.address"] = "Customer address is required";
  }

  if (!partial || payload.products !== undefined) {
    if (!Array.isArray(products) || products.length === 0) {
      errors.products = "At least one product is required";
    } else {
      products.forEach((product, index) => {
        const path = `products[${index}]`;
        if (!product.productName && !product.name)
          errors[`${path}.productName`] = "Product name is required";
        if (Number(product.quantity || 0) <= 0)
          errors[`${path}.quantity`] = "Quantity must be greater than 0";
        if (Number(product.unitPrice || product.price || 0) < 0)
          errors[`${path}.unitPrice`] = "Unit price must be at least 0";
      });
    }
  }

  if (payload.paymentStatus && !CRM_PAYMENT_STATUSES.includes(payload.paymentStatus)) {
    errors.paymentStatus = "Invalid payment status";
  }

  if (payload.orderStatus && !CRM_ORDER_STATUSES.includes(payload.orderStatus)) {
    errors.orderStatus = "Invalid order status";
  }

  if (payload.source && !CRM_ORDER_SOURCES.includes(payload.source)) {
    errors.source = "Invalid order source";
  }

  if (payload.discount !== undefined && Number(payload.discount) < 0) {
    errors.discount = "Discount must be at least 0";
  }

  if (payload.deliveryCharge !== undefined && Number(payload.deliveryCharge) < 0) {
    errors.deliveryCharge = "Delivery charge must be at least 0";
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

const buildListFilter = (query = {}) => {
  const { date, status, orderStatus, paymentStatus, phone, search } = query;
  const filter = {};

  if (date) {
    const { start, end } = getStartAndEndOfDay(date);
    filter.orderDate = { $gte: start, $lte: end };
  }

  if (status || orderStatus) filter.orderStatus = status || orderStatus;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (phone) filter["customer.phone"] = normalizeIndianPhone(phone);

  if (search) {
    const regex = { $regex: search, $options: "i" };
    filter.$or = [
      { orderNumber: regex },
      { "customer.name": regex },
      { "customer.phone": regex },
      { "products.productName": regex },
    ];
  }

  return filter;
};

const createOrder = async (req, res) => {
  try {
    const { isValid, errors } = validateOrderPayload(req.body);
    if (!isValid)
      return res
        .status(400)
        .json({ status: false, message: "Validation failed", errors });

    const orderDate = req.body.orderDate ? new Date(req.body.orderDate) : new Date();
    const orderNumber = await generateOrderNumber(orderDate);

    const totals = buildOrderTotals(
      req.body.products,
      req.body.discount,
      req.body.deliveryCharge,
    );

    const customer = {
      ...req.body.customer,
      phone: normalizeIndianPhone(req.body.customer.phone),
    };

    const order = await AquaCRMOrder.create({
      orderNumber,
      orderDate,
      deliveryDate: req.body.deliveryDate ? new Date(req.body.deliveryDate) : null,
      customer,
      products: totals.normalizedProducts,
      subtotal: totals.subtotal,
      discount: totals.discount,
      deliveryCharge: totals.deliveryCharge,
      grandTotal: totals.grandTotal,
      paymentStatus: req.body.paymentStatus || "pending",
      orderStatus: req.body.orderStatus || "new",
      source: req.body.source || "crm",
      invoiceId: req.body.invoiceId || null,
      notes: req.body.notes || "",
      createdBy: req.user?._id || req.user?.id || null,
    });

    return res.status(201).json({
      status: true,
      message: "Order created successfully",
      data: order,
    });
  } catch (error) {
    console.error("Create CRM order error:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to create order",
      error: error.message,
    });
  }
};

const getOrders = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const skip = (page - 1) * limit;
    const filter = buildListFilter(req.query);

    const [orders, total] = await Promise.all([
      AquaCRMOrder.find(filter)
        .sort({ orderDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaCRMOrder.countDocuments(filter),
    ]);

    return res.status(200).json({
      status: true,
      data: orders,
      no: orders.length,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get CRM orders error:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to fetch orders",
      error: error.message,
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

const getOrdersByDateRange = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to)
      return res.status(400).json({
        status: false,
        message: "from and to dates are required",
      });

    const fromDate = new Date(from);
    fromDate.setHours(0, 0, 0, 0);

    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const filter = {
      ...buildListFilter(req.query),
      orderDate: { $gte: fromDate, $lte: toDate },
    };

    const orders = await AquaCRMOrder.find(filter)
      .sort({ orderDate: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      status: true,
      data: orders,
      no: orders.length,
    });
  } catch (error) {
    console.error("Get CRM orders by range error:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to fetch orders by date range",
      error: error.message,
    });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ status: false, message: "Invalid order id" });

    const order = await AquaCRMOrder.findById(id);
    if (!order)
      return res.status(404).json({ status: false, message: "Order not found" });

    return res.status(200).json({ status: true, data: order });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: "Failed to fetch order",
      error: error.message,
    });
  }
};

const updateOrder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ status: false, message: "Invalid order id" });

    const { isValid, errors } = validateOrderPayload(req.body, { partial: true });
    if (!isValid)
      return res
        .status(400)
        .json({ status: false, message: "Validation failed", errors });

    const updatePayload = { ...req.body };

    if (updatePayload.customer?.phone) {
      updatePayload.customer.phone = normalizeIndianPhone(updatePayload.customer.phone);
    }

    if (updatePayload.products) {
      const existingOrder = await AquaCRMOrder.findById(id).lean();
      const totals = buildOrderTotals(
        updatePayload.products,
        updatePayload.discount ?? existingOrder?.discount ?? 0,
        updatePayload.deliveryCharge ?? existingOrder?.deliveryCharge ?? 0,
      );

      updatePayload.products = totals.normalizedProducts;
      updatePayload.subtotal = totals.subtotal;
      updatePayload.discount = totals.discount;
      updatePayload.deliveryCharge = totals.deliveryCharge;
      updatePayload.grandTotal = totals.grandTotal;
    }

    const order = await AquaCRMOrder.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    });

    if (!order)
      return res.status(404).json({ status: false, message: "Order not found" });

    return res.status(200).json({
      status: true,
      message: "Order updated successfully",
      data: order,
    });
  } catch (error) {
    console.error("Update CRM order error:", error);
    return res.status(500).json({
      status: false,
      message: "Failed to update order",
      error: error.message,
    });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { orderStatus, paymentStatus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ status: false, message: "Invalid order id" });

    const updatePayload = {};

    if (orderStatus) {
      if (!CRM_ORDER_STATUSES.includes(orderStatus))
        return res.status(400).json({ status: false, message: "Invalid order status" });
      updatePayload.orderStatus = orderStatus;
    }

    if (paymentStatus) {
      if (!CRM_PAYMENT_STATUSES.includes(paymentStatus))
        return res.status(400).json({ status: false, message: "Invalid payment status" });
      updatePayload.paymentStatus = paymentStatus;
    }

    if (!Object.keys(updatePayload).length)
      return res.status(400).json({
        status: false,
        message: "orderStatus or paymentStatus is required",
      });

    const order = await AquaCRMOrder.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    });

    if (!order)
      return res.status(404).json({ status: false, message: "Order not found" });

    return res.status(200).json({
      status: true,
      message: "Order status updated successfully",
      data: order,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ status: false, message: "Invalid order id" });

    const order = await AquaCRMOrder.findByIdAndDelete(id);
    if (!order)
      return res.status(404).json({ status: false, message: "Order not found" });

    return res.status(200).json({
      status: true,
      message: "Order deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: "Failed to delete order",
      error: error.message,
    });
  }
};

const CRMOrderOperations = {
  createOrder,
  getOrders,
  getTodayOrders,
  getTomorrowOrders,
  getOrdersByDateRange,
  getOrderById,
  updateOrder,
  updateOrderStatus,
  deleteOrder,
};

export default CRMOrderOperations;
