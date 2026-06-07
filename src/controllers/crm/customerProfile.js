import mongoose from "mongoose";
import AquaEcomUser from "../../models/user.js";
import AquaOrder from "../../models/orders.js";
import AquaProduct from "../../models/product.js";
import AquaInvoice from "../../models/crm/invoice.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const parsePagination = (query = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 200);
  return { page, limit, skip: (page - 1) * limit };
};

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizePhone = (phone) =>
  String(phone || "")
    .replace(/\s|-/g, "")
    .replace(/^\+91/, "")
    .replace(/^91/, "")
    .trim();

const normalizeEmail = (email) => String(email || "").toLowerCase().trim();

const compactAddress = (address) => {
  if (!address) return "";
  if (typeof address === "string") return address;
  if (address instanceof Map) return Array.from(address.values()).filter(Boolean).join(", ");
  if (typeof address === "object") {
    return Object.values(address).filter(Boolean).join(", ");
  }
  return String(address);
};

const invoiceAmount = (invoice) =>
  (invoice.products || []).reduce(
    (sum, product) =>
      sum + Number(product.productQuantity || 0) * Number(product.productPrice || 0),
    0,
  );

const sanitizeUserPayload = (payload = {}) => {
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
  if (typeof clean.email === "string") clean.email = normalizeEmail(clean.email);
  return clean;
};

const buildOnlineFilter = (query = {}) => {
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

  if (email) filter.email = normalizeEmail(email);
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

const buildInvoiceSearchFilter = (query = {}) => {
  const filter = {};
  const { search, email, phone } = query;

  if (search) {
    const safe = escapeRegex(String(search).trim());
    const regex = new RegExp(safe, "i");
    const asNumber = Number(safe);
    filter.$or = [
      { invoiceNo: regex },
      { "customerDetails.name": regex },
      { "customerDetails.email": regex },
      { "customerDetails.address": regex },
    ];
    if (!Number.isNaN(asNumber)) filter.$or.push({ "customerDetails.phone": asNumber });
  }

  if (email) filter["customerDetails.email"] = normalizeEmail(email);
  if (phone) {
    const asNumber = Number(normalizePhone(phone));
    filter["customerDetails.phone"] = Number.isNaN(asNumber) ? phone : asNumber;
  }

  return filter;
};

const getReviewListForUsers = async (userIds = []) => {
  if (!userIds.length) return new Map();
  const idSet = new Set(userIds.map(String));
  const products = await AquaProduct.find(
    { "reviews.user": { $in: userIds } },
    { title: 1, slug: 1, photos: 1, reviews: 1 },
  ).lean();

  const map = new Map(userIds.map((id) => [String(id), []]));
  products.forEach((product) => {
    (product.reviews || []).forEach((review) => {
      const reviewUserId = String(review.user || "");
      if (!idSet.has(reviewUserId)) return;
      map.get(reviewUserId).push({
        _id: review._id,
        source: "online-product-review",
        productId: product._id,
        productTitle: product.title,
        productSlug: product.slug,
        productPhoto: product.photos?.[0] || null,
        name: review.name,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
      });
    });
  });

  map.forEach((reviews) =>
    reviews.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
  );
  return map;
};

const getInvoicesForIdentity = async ({ phone, email }) => {
  const or = [];
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);
  const phoneNumber = Number(normalizedPhone);

  if (normalizedPhone) {
    or.push({ "customerDetails.phone": normalizedPhone });
    if (!Number.isNaN(phoneNumber)) or.push({ "customerDetails.phone": phoneNumber });
  }
  if (normalizedEmail) or.push({ "customerDetails.email": normalizedEmail });
  if (!or.length) return [];

  return AquaInvoice.find({ $or: or }).sort({ createdAt: -1 }).lean();
};

const mapOnlineCustomer = ({ customer, orders = [], reviews = [], invoices = [] }) => {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
  return {
    _id: customer._id,
    source: "online",
    customerType: "online",
    name: name || customer.email || customer.phone || "Online customer",
    phone: customer.phone || null,
    email: customer.email || null,
    address:
      compactAddress(customer.selectedAddress) ||
      compactAddress(customer.addresses?.[0]) ||
      compactAddress(customer.gstDetails?.gstAddres),
    selectedAddress: customer.selectedAddress || null,
    addresses: customer.addresses || [],
    customer,
    ordersCount: orders.length,
    reviewsCount: reviews.length,
    invoicesCount: invoices.length,
    totalSpent:
      orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0) +
      invoices.reduce((sum, invoice) => sum + invoiceAmount(invoice), 0),
    latestOrder: orders[0] || null,
    latestInvoice: invoices[0] || null,
    latestReview: reviews[0] || null,
    createdAt: customer.createdAt || customer.userSignedupDate,
    updatedAt: customer.updatedAt || customer.lastDetailsUpdatedDate,
    status: "online-user",
  };
};

const groupOfflineInvoices = async (query = {}) => {
  const invoices = await AquaInvoice.find(buildInvoiceSearchFilter(query))
    .sort({ createdAt: -1 })
    .lean();

  const phones = Array.from(
    new Set(
      invoices
        .map((invoice) => normalizePhone(invoice.customerDetails?.phone))
        .filter(Boolean),
    ),
  );
  const emails = Array.from(
    new Set(
      invoices
        .map((invoice) => normalizeEmail(invoice.customerDetails?.email))
        .filter(Boolean),
    ),
  );

  const onlineOr = [];
  phones.forEach((phone) => {
    const asNumber = Number(phone);
    if (!Number.isNaN(asNumber)) onlineOr.push({ phone: asNumber });
  });
  emails.forEach((email) => onlineOr.push({ email }));

  const onlineUsers = onlineOr.length
    ? await AquaEcomUser.find({ $or: onlineOr }).select("phone email").lean()
    : [];
  const onlinePhones = new Set(onlineUsers.map((user) => normalizePhone(user.phone)));
  const onlineEmails = new Set(onlineUsers.map((user) => normalizeEmail(user.email)));

  const groups = new Map();
  invoices.forEach((invoice) => {
    const phone = normalizePhone(invoice.customerDetails?.phone);
    const email = normalizeEmail(invoice.customerDetails?.email);
    if ((phone && onlinePhones.has(phone)) || (email && onlineEmails.has(email))) return;

    const key = phone || email || String(invoice._id);
    if (!groups.has(key)) {
      groups.set(key, {
        _id: `offline:${encodeURIComponent(key)}`,
        key,
        source: "offline",
        customerType: "offline-invoice",
        name: invoice.customerDetails?.name || "Offline invoice customer",
        phone: invoice.customerDetails?.phone || null,
        email: invoice.customerDetails?.email || null,
        address: invoice.customerDetails?.address || "",
        addresses: invoice.customerDetails?.address ? [{ street: invoice.customerDetails.address }] : [],
        invoices: [],
        invoicesCount: 0,
        ordersCount: 0,
        reviewsCount: 0,
        totalSpent: 0,
        latestInvoice: null,
        latestReview: null,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        status: "offline-invoice",
      });
    }

    const group = groups.get(key);
    group.invoices.push(invoice);
    group.invoicesCount += 1;
    group.totalSpent += invoiceAmount(invoice);
    if (invoice.review) {
      group.reviewsCount += 1;
      if (!group.latestReview) {
        group.latestReview = {
          _id: invoice._id,
          source: "offline-invoice-review",
          invoiceNo: invoice.invoiceNo,
          comment: invoice.review,
          createdAt: invoice.updatedAt || invoice.createdAt,
        };
      }
    }
    if (!group.latestInvoice) group.latestInvoice = invoice;
  });

  return Array.from(groups.values());
};

const listOnlineProfiles = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = buildOnlineFilter(req.query);

  const [customers, total] = await Promise.all([
    AquaEcomUser.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AquaEcomUser.countDocuments(filter),
  ]);

  const ids = customers.map((customer) => customer._id);
  const [orders, reviewMap, invoiceGroups] = await Promise.all([
    AquaOrder.find({ user: { $in: ids } }).sort({ createdAt: -1 }).lean(),
    getReviewListForUsers(ids),
    Promise.all(
      customers.map((customer) =>
        getInvoicesForIdentity({ phone: customer.phone, email: customer.email }),
      ),
    ),
  ]);

  const orderMap = new Map(ids.map((id) => [String(id), []]));
  orders.forEach((order) => orderMap.get(String(order.user))?.push(order));

  const data = customers.map((customer, index) =>
    mapOnlineCustomer({
      customer,
      orders: orderMap.get(String(customer._id)) || [],
      reviews: reviewMap.get(String(customer._id)) || [],
      invoices: invoiceGroups[index] || [],
    }),
  );

  return res.status(200).json({
    success: true,
    source: "online",
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    count: data.length,
    data,
  });
};

const listOfflineProfiles = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const groups = await groupOfflineInvoices(req.query);
  const paged = groups.slice(skip, skip + limit);

  return res.status(200).json({
    success: true,
    source: "offline",
    page,
    limit,
    total: groups.length,
    totalPages: Math.ceil(groups.length / limit) || 1,
    count: paged.length,
    data: paged,
  });
};

const listCustomerProfiles = async (req, res) => {
  try {
    const source = req.query.source || "online";
    if (source === "offline") return listOfflineProfiles(req, res);
    if (source !== "all") return listOnlineProfiles(req, res);

    const [onlinePayload, offlinePayload] = await Promise.all([
      new Promise((resolve, reject) => {
        const fakeRes = {
          status: () => ({ json: resolve }),
        };
        listOnlineProfiles(req, fakeRes).catch(reject);
      }),
      new Promise((resolve, reject) => {
        const fakeRes = {
          status: () => ({ json: resolve }),
        };
        listOfflineProfiles(req, fakeRes).catch(reject);
      }),
    ]);

    const data = [...(onlinePayload.data || []), ...(offlinePayload.data || [])].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );

    return res.status(200).json({
      success: true,
      source: "all",
      count: data.length,
      total: (onlinePayload.total || 0) + (offlinePayload.total || 0),
      data,
      buckets: {
        online: onlinePayload.total || 0,
        offline: offlinePayload.total || 0,
      },
    });
  } catch (error) {
    console.error("CRM listCustomerProfiles error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getOnlineProfile = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid customer id" });
    }

    const customer = await AquaEcomUser.findById(id).select("-password").lean();
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const [orders, reviewMap, invoices] = await Promise.all([
      AquaOrder.find({ user: id })
        .sort({ createdAt: -1 })
        .populate("items.productId", "title slug photos price")
        .lean(),
      getReviewListForUsers([id]),
      getInvoicesForIdentity({ phone: customer.phone, email: customer.email }),
    ]);

    const reviews = reviewMap.get(String(id)) || [];
    return res.status(200).json({
      success: true,
      data: {
        profile: mapOnlineCustomer({ customer, orders, reviews, invoices }),
        customer,
        addresses: customer.addresses || [],
        selectedAddress: customer.selectedAddress || null,
        orders,
        invoices,
        reviews,
        stats: {
          ordersCount: orders.length,
          invoicesCount: invoices.length,
          reviewsCount: reviews.length,
          totalSpent:
            orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0) +
            invoices.reduce((sum, invoice) => sum + invoiceAmount(invoice), 0),
        },
      },
    });
  } catch (error) {
    console.error("CRM getOnlineProfile error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateOnlineProfile = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid customer id" });
    }

    const payload = sanitizeUserPayload(req.body);
    payload.lastDetailsUpdatedDate = new Date();
    payload.profileUpdated = new Date();

    const updated = await AquaEcomUser.findByIdAndUpdate(
      id,
      { $set: payload },
      { new: true, runValidators: true },
    ).select("-password");

    if (!updated) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("CRM updateOnlineProfile error:", error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "Duplicate email or phone" });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateOnlineAddresses = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid customer id" });
    }

    const { addresses, selectedAddress } = req.body;
    const update = { lastDetailsUpdatedDate: new Date(), profileUpdated: new Date() };
    if (Array.isArray(addresses)) update.addresses = addresses;
    if (selectedAddress !== undefined) update.selectedAddress = selectedAddress;

    const updated = await AquaEcomUser.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true },
    ).select("-password");

    if (!updated) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("CRM updateOnlineAddresses error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getOfflineProfile = async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key || "");
    const normalizedPhone = normalizePhone(key);
    const normalizedEmail = normalizeEmail(key);
    const phoneNumber = Number(normalizedPhone);
    const or = [];

    if (normalizedPhone) {
      or.push({ "customerDetails.phone": normalizedPhone });
      if (!Number.isNaN(phoneNumber)) or.push({ "customerDetails.phone": phoneNumber });
    }
    if (normalizedEmail && normalizedEmail.includes("@")) {
      or.push({ "customerDetails.email": normalizedEmail });
    }
    if (!or.length) {
      return res.status(400).json({ success: false, message: "Phone or email key is required" });
    }

    const invoices = await AquaInvoice.find({ $or: or }).sort({ createdAt: -1 }).lean();
    if (!invoices.length) {
      return res.status(404).json({ success: false, message: "Offline customer not found" });
    }

    const first = invoices[0];
    const reviews = invoices
      .filter((invoice) => invoice.review)
      .map((invoice) => ({
        _id: invoice._id,
        source: "offline-invoice-review",
        invoiceNo: invoice.invoiceNo,
        comment: invoice.review,
        createdAt: invoice.updatedAt || invoice.createdAt,
      }));

    return res.status(200).json({
      success: true,
      data: {
        profile: {
          _id: `offline:${encodeURIComponent(key)}`,
          key,
          source: "offline",
          customerType: "offline-invoice",
          name: first.customerDetails?.name || "Offline invoice customer",
          phone: first.customerDetails?.phone || null,
          email: first.customerDetails?.email || null,
          address: first.customerDetails?.address || "",
          invoicesCount: invoices.length,
          reviewsCount: reviews.length,
          totalSpent: invoices.reduce((sum, invoice) => sum + invoiceAmount(invoice), 0),
          latestInvoice: invoices[0],
          latestReview: reviews[0] || null,
        },
        customer: first.customerDetails || {},
        addresses: first.customerDetails?.address ? [{ street: first.customerDetails.address }] : [],
        invoices,
        orders: [],
        reviews,
        stats: {
          ordersCount: 0,
          invoicesCount: invoices.length,
          reviewsCount: reviews.length,
          totalSpent: invoices.reduce((sum, invoice) => sum + invoiceAmount(invoice), 0),
        },
      },
    });
  } catch (error) {
    console.error("CRM getOfflineProfile error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateOfflineProfile = async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key || "");
    const normalizedPhone = normalizePhone(key);
    const normalizedEmail = normalizeEmail(key);
    const phoneNumber = Number(normalizedPhone);
    const or = [];

    if (normalizedPhone) {
      or.push({ "customerDetails.phone": normalizedPhone });
      if (!Number.isNaN(phoneNumber)) or.push({ "customerDetails.phone": phoneNumber });
    }
    if (normalizedEmail && normalizedEmail.includes("@")) {
      or.push({ "customerDetails.email": normalizedEmail });
    }
    if (!or.length) {
      return res.status(400).json({ success: false, message: "Phone or email key is required" });
    }

    const allowed = ["name", "phone", "email", "address"];
    const customerDetails = {};
    allowed.forEach((field) => {
      if (req.body[field] !== undefined) customerDetails[`customerDetails.${field}`] = req.body[field];
      if (req.body.customerDetails?.[field] !== undefined) {
        customerDetails[`customerDetails.${field}`] = req.body.customerDetails[field];
      }
    });
    if (customerDetails["customerDetails.email"]) {
      customerDetails["customerDetails.email"] = normalizeEmail(customerDetails["customerDetails.email"]);
    }
    if (customerDetails["customerDetails.phone"]) {
      const asNumber = Number(normalizePhone(customerDetails["customerDetails.phone"]));
      customerDetails["customerDetails.phone"] = Number.isNaN(asNumber)
        ? customerDetails["customerDetails.phone"]
        : asNumber;
    }

    if (!Object.keys(customerDetails).length) {
      return res.status(400).json({ success: false, message: "No editable fields supplied" });
    }

    const result = await AquaInvoice.updateMany({ $or: or }, { $set: customerDetails });
    return res.status(200).json({
      success: true,
      message: "Offline invoice customer updated",
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (error) {
    console.error("CRM updateOfflineProfile error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export default {
  listCustomerProfiles,
  getOnlineProfile,
  updateOnlineProfile,
  updateOnlineAddresses,
  getOfflineProfile,
  updateOfflineProfile,
};
