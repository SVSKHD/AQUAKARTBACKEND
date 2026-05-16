import mongoose from "mongoose";
import AquaEcomUser from "../../models/user.js";
import AquaOrder from "../../models/orders.js";
import AquaProduct from "../../models/product.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const parsePagination = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 200);
  return { page, limit, skip: (page - 1) * limit };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildCustomerFilter = (query) => {
  const filter = {};
  const { search, email, phone, role, isEmailVerfied } = query;

  if (search) {
    const safe = escapeRegex(String(search).trim());
    const regex = new RegExp(safe, "i");
    const or = [
      { email: regex },
      { firstName: regex },
      { lastName: regex },
      { alternativeEmail: regex },
    ];
    const asNumber = Number(safe);
    if (!Number.isNaN(asNumber)) or.push({ phone: asNumber });
    filter.$or = or;
  }

  if (email) filter.email = String(email).toLowerCase().trim();
  if (phone) {
    const asNumber = Number(phone);
    filter.phone = Number.isNaN(asNumber) ? phone : asNumber;
  }
  if (role !== undefined && role !== "") {
    const asNumber = Number(role);
    if (!Number.isNaN(asNumber)) filter.role = asNumber;
  }
  if (isEmailVerfied === "true") filter.isEmailVerfied = true;
  if (isEmailVerfied === "false") filter.isEmailVerfied = false;

  return filter;
};

const sanitizeUpdatePayload = (payload = {}) => {
  const blocked = [
    "password",
    "_id",
    "id",
    "emailOtp",
    "EmailOtp",
    "MobileOtp",
    "mobileOtp",
    "resetPasswordOtp",
    "confirmationOtp",
    "verificationOtp",
    "googleData",
    "facebookData",
    "twitterData",
    "createdAt",
    "updatedAt",
  ];
  const clean = { ...payload };
  blocked.forEach((field) => delete clean[field]);
  if (typeof clean.email === "string") clean.email = clean.email.toLowerCase().trim();
  return clean;
};

// ───────────────────────────── Customers CRUD ─────────────────────────────

const listCustomers = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = buildCustomerFilter(req.query);
    const sort = { createdAt: -1 };

    const [customers, total] = await Promise.all([
      AquaEcomUser.find(filter)
        .select("-password")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      AquaEcomUser.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      count: customers.length,
      data: customers,
    });
  } catch (error) {
    console.error("Admin listCustomers error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid customer id" });

    const customer = await AquaEcomUser.findById(id).select("-password").lean();
    if (!customer)
      return res.status(404).json({ success: false, message: "Customer not found" });

    const [orders, reviews] = await Promise.all([
      AquaOrder.find({ user: id }).sort({ createdAt: -1 }).lean(),
      AquaProduct.find(
        { "reviews.user": id },
        { title: 1, slug: 1, reviews: 1, photos: 1 },
      ).lean(),
    ]);

    const customerReviews = reviews.flatMap((product) =>
      (product.reviews || [])
        .filter((review) => String(review.user) === String(id))
        .map((review) => ({
          _id: review._id,
          productId: product._id,
          productTitle: product.title,
          productSlug: product.slug,
          productPhoto: product.photos?.[0] || null,
          rating: review.rating,
          comment: review.comment,
          name: review.name,
          createdAt: review.createdAt,
        })),
    );

    const orderStats = orders.reduce(
      (acc, order) => {
        acc.totalSpent += Number(order.totalAmount) || 0;
        acc.statusBreakdown[order.orderStatus] =
          (acc.statusBreakdown[order.orderStatus] || 0) + 1;
        return acc;
      },
      { totalSpent: 0, statusBreakdown: {} },
    );

    return res.status(200).json({
      success: true,
      data: {
        customer,
        orders,
        reviews: customerReviews,
        stats: {
          ordersCount: orders.length,
          reviewsCount: customerReviews.length,
          totalSpent: orderStats.totalSpent,
          orderStatusBreakdown: orderStats.statusBreakdown,
        },
      },
    });
  } catch (error) {
    console.error("Admin getCustomerById error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const createCustomer = async (req, res) => {
  try {
    const payload = sanitizeUpdatePayload(req.body);
    const password = req.body?.password;

    if (!payload.email && !payload.phone) {
      return res
        .status(400)
        .json({ success: false, message: "Email or phone is required" });
    }

    const existing = await AquaEcomUser.findOne({
      $or: [
        payload.email ? { email: payload.email } : null,
        payload.phone ? { phone: payload.phone } : null,
      ].filter(Boolean),
    });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, message: "Customer already exists" });
    }

    const customer = new AquaEcomUser({ ...payload, password });
    await customer.save();

    const result = await AquaEcomUser.findById(customer._id).select("-password");
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Admin createCustomer error:", error);
    if (error?.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "Duplicate email or phone" });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid customer id" });

    const payload = sanitizeUpdatePayload(req.body);
    payload.lastDetailsUpdatedDate = new Date();

    const updated = await AquaEcomUser.findByIdAndUpdate(
      id,
      { $set: payload },
      { new: true, runValidators: true },
    ).select("-password");

    if (!updated)
      return res.status(404).json({ success: false, message: "Customer not found" });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("Admin updateCustomer error:", error);
    if (error?.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "Duplicate email or phone" });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid customer id" });

    const deleted = await AquaEcomUser.findByIdAndDelete(id);
    if (!deleted)
      return res.status(404).json({ success: false, message: "Customer not found" });

    return res.status(200).json({
      success: true,
      message: "Customer deleted successfully",
      data: { _id: deleted._id, email: deleted.email },
    });
  } catch (error) {
    console.error("Admin deleteCustomer error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ───────────────────────────── Customer Orders ─────────────────────────────

const listCustomerOrders = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid customer id" });

    const { page, limit, skip } = parsePagination(req.query);
    const filter = { user: id };
    if (req.query.orderStatus) filter.orderStatus = req.query.orderStatus;
    if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;

    const [orders, total] = await Promise.all([
      AquaOrder.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("items.productId", "title slug photos price"),
      AquaOrder.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error("Admin listCustomerOrders error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getCustomerOrder = async (req, res) => {
  try {
    const { id, orderId } = req.params;
    if (!isValidObjectId(id) || !isValidObjectId(orderId))
      return res.status(400).json({ success: false, message: "Invalid id" });

    const order = await AquaOrder.findOne({ _id: orderId, user: id }).populate(
      "items.productId",
      "title slug photos price",
    );

    if (!order)
      return res.status(404).json({ success: false, message: "Order not found" });

    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error("Admin getCustomerOrder error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateCustomerOrder = async (req, res) => {
  try {
    const { id, orderId } = req.params;
    if (!isValidObjectId(id) || !isValidObjectId(orderId))
      return res.status(400).json({ success: false, message: "Invalid id" });

    const updated = await AquaOrder.findOneAndUpdate(
      { _id: orderId, user: id },
      { $set: req.body },
      { new: true },
    );

    if (!updated)
      return res.status(404).json({ success: false, message: "Order not found" });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("Admin updateCustomerOrder error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteCustomerOrder = async (req, res) => {
  try {
    const { id, orderId } = req.params;
    if (!isValidObjectId(id) || !isValidObjectId(orderId))
      return res.status(400).json({ success: false, message: "Invalid id" });

    const deleted = await AquaOrder.findOneAndDelete({ _id: orderId, user: id });
    if (!deleted)
      return res.status(404).json({ success: false, message: "Order not found" });

    return res
      .status(200)
      .json({ success: true, message: "Order deleted successfully" });
  } catch (error) {
    console.error("Admin deleteCustomerOrder error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─────────────────────────── Customer Reviews ────────────────────────────

const listCustomerReviews = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid customer id" });

    const products = await AquaProduct.find(
      { "reviews.user": id },
      { title: 1, slug: 1, reviews: 1, photos: 1, ratings: 1, numberOfReviews: 1 },
    ).lean();

    const reviews = products.flatMap((product) =>
      (product.reviews || [])
        .filter((review) => String(review.user) === String(id))
        .map((review) => ({
          _id: review._id,
          productId: product._id,
          productTitle: product.title,
          productSlug: product.slug,
          productPhoto: product.photos?.[0] || null,
          name: review.name,
          rating: review.rating,
          comment: review.comment,
          createdAt: review.createdAt,
        })),
    );

    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews,
    });
  } catch (error) {
    console.error("Admin listCustomerReviews error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateCustomerReview = async (req, res) => {
  try {
    const { id, productId, reviewId } = req.params;
    const { rating, comment } = req.body;

    if (!isValidObjectId(id) || !isValidObjectId(productId) || !isValidObjectId(reviewId))
      return res.status(400).json({ success: false, message: "Invalid id" });

    const product = await AquaProduct.findById(productId);
    if (!product)
      return res.status(404).json({ success: false, message: "Product not found" });

    const review = product.reviews.id(reviewId);
    if (!review || String(review.user) !== String(id))
      return res.status(404).json({ success: false, message: "Review not found" });

    if (rating !== undefined) {
      const parsedRating = Number(rating);
      if (Number.isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        return res
          .status(400)
          .json({ success: false, message: "Rating must be between 1 and 5" });
      }
      review.rating = parsedRating;
    }
    if (comment !== undefined) review.comment = comment;
    review.createdAt = new Date();

    product.numberOfReviews = product.reviews.length;
    product.ratings =
      product.reviews.length > 0
        ? product.reviews.reduce((acc, r) => acc + r.rating, 0) /
          product.reviews.length
        : 0;

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Review updated",
      data: { productId: product._id, review },
    });
  } catch (error) {
    console.error("Admin updateCustomerReview error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteCustomerReview = async (req, res) => {
  try {
    const { id, productId, reviewId } = req.params;
    if (!isValidObjectId(id) || !isValidObjectId(productId) || !isValidObjectId(reviewId))
      return res.status(400).json({ success: false, message: "Invalid id" });

    const product = await AquaProduct.findById(productId);
    if (!product)
      return res.status(404).json({ success: false, message: "Product not found" });

    const reviewIndex = product.reviews.findIndex(
      (review) =>
        String(review._id) === String(reviewId) &&
        String(review.user) === String(id),
    );

    if (reviewIndex === -1)
      return res.status(404).json({ success: false, message: "Review not found" });

    product.reviews.splice(reviewIndex, 1);
    product.numberOfReviews = product.reviews.length;
    product.ratings =
      product.reviews.length > 0
        ? product.reviews.reduce((acc, r) => acc + r.rating, 0) /
          product.reviews.length
        : 0;

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Review deleted",
      data: {
        productId: product._id,
        ratings: product.ratings,
        numberOfReviews: product.numberOfReviews,
      },
    });
  } catch (error) {
    console.error("Admin deleteCustomerReview error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const AdminCustomerOperations = {
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomerOrders,
  getCustomerOrder,
  updateCustomerOrder,
  deleteCustomerOrder,
  listCustomerReviews,
  updateCustomerReview,
  deleteCustomerReview,
};

export default AdminCustomerOperations;
