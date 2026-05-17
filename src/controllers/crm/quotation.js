import mongoose from "mongoose";
import { nanoid } from "nanoid";
import AquaQuotation from "../../models/crm/quotation.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePagination = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 200);
  return { page, limit, skip: (page - 1) * limit };
};

const generateQuotationNo = () => {
  const now = new Date();
  const uniqueId = nanoid(10);
  return `AQQ${uniqueId}|${now.getDate()}${now.getMonth() + 1}${now.getFullYear()}`;
};

const validateQuotationPayload = (payload = {}) => {
  const errors = {};
  const customerName = payload?.customerDetails?.name;
  const customerPhone = payload?.customerDetails?.phone;
  const products = payload?.products;
  const gstEnabled = payload?.gst === true;

  if (!customerName || typeof customerName !== "string" || !customerName.trim()) {
    errors["customerDetails.name"] = "Customer name is required";
  }
  if (
    customerPhone === undefined ||
    customerPhone === null ||
    String(customerPhone).trim() === ""
  ) {
    errors["customerDetails.phone"] = "Customer phone is required";
  }

  if (!Array.isArray(products) || products.length === 0) {
    errors.products = "At least one product is required";
  } else {
    products.forEach((product, index) => {
      const path = `products[${index}]`;
      if (
        !product?.productName ||
        typeof product.productName !== "string" ||
        !product.productName.trim()
      ) {
        errors[`${path}.productName`] = "Product name is required";
      }
      if (
        product?.productQuantity === undefined ||
        product?.productQuantity === null ||
        product.productQuantity === ""
      ) {
        errors[`${path}.productQuantity`] = "Product quantity is required";
      } else if (Number(product.productQuantity) <= 0) {
        errors[`${path}.productQuantity`] =
          "Product quantity must be greater than 0";
      }
      if (
        product?.productPrice === undefined ||
        product?.productPrice === null ||
        product.productPrice === ""
      ) {
        errors[`${path}.productPrice`] = "Product price is required";
      } else if (Number(product.productPrice) < 0) {
        errors[`${path}.productPrice`] = "Product price must be at least 0";
      }
    });
  }

  if (gstEnabled) {
    const gstNo = payload?.gstDetails?.gstNo;
    const gstName = payload?.gstDetails?.gstName;
    if (!gstNo || typeof gstNo !== "string" || !gstNo.trim()) {
      errors["gstDetails.gstNo"] = "GST number is required when gst is true";
    }
    if (!gstName || typeof gstName !== "string" || !gstName.trim()) {
      errors["gstDetails.gstName"] = "GST name is required when gst is true";
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

const computeTotals = (payload) => {
  const products = Array.isArray(payload.products) ? payload.products : [];
  let subTotal = 0;
  const enrichedProducts = products.map((product) => {
    const quantity = Number(product.productQuantity) || 0;
    const price = Number(product.productPrice) || 0;
    const discount = Number(product.productDiscount) || 0;
    const tax = Number(product.productTax) || 0;
    const lineTotal = Math.max(quantity * price - discount, 0) + tax;
    subTotal += lineTotal;
    return { ...product, productTotal: lineTotal };
  });

  const discount = Number(payload.discount) || 0;
  const tax = Number(payload.tax) || 0;
  const totalAmount = Math.max(subTotal - discount, 0) + tax;

  return {
    products: enrichedProducts,
    subTotal,
    discount,
    tax,
    totalAmount,
  };
};

// ─────────────────────────────── CRUD ────────────────────────────────────

const createQuotation = async (req, res) => {
  try {
    const { isValid, errors } = validateQuotationPayload(req.body);
    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    const totals = computeTotals(req.body);
    const payload = {
      ...req.body,
      ...totals,
      quotationNo: req.body.quotationNo || generateQuotationNo(),
      date: req.body.date || new Date().toISOString().split("T")[0],
      createdBy: req.user?._id,
    };

    const saved = await new AquaQuotation(payload).save();
    return res.status(201).json({ success: true, data: saved });
  } catch (error) {
    console.error("createQuotation error:", error);
    if (error?.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "Quotation number already exists" });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateQuotation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }

    const quotation = await AquaQuotation.findById(id);
    if (!quotation) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }

    const { isValid, errors } = validateQuotationPayload(req.body);
    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    const totals = computeTotals(req.body);
    const updatePayload = {
      ...req.body,
      ...totals,
      quotationNo: quotation.quotationNo,
    };
    delete updatePayload._id;
    delete updatePayload.createdAt;

    const updated = await AquaQuotation.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("updateQuotation error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteQuotation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }
    const deleted = await AquaQuotation.findByIdAndDelete(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }
    return res
      .status(200)
      .json({ success: true, message: "Quotation deleted successfully" });
  } catch (error) {
    console.error("deleteQuotation error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getQuotations = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { status, gst, search, customer } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (gst === "true") filter.gst = true;
    if (gst === "false") filter.gst = false;
    if (customer && isValidObjectId(customer)) filter.customer = customer;
    if (search) {
      const regex = new RegExp(escapeRegex(String(search).trim()), "i");
      filter.$or = [
        { quotationNo: regex },
        { "customerDetails.name": regex },
        { "customerDetails.email": regex },
      ];
    }

    const [quotations, total] = await Promise.all([
      AquaQuotation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("customer", "firstName lastName email phone")
        .lean(),
      AquaQuotation.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      count: quotations.length,
      data: quotations,
    });
  } catch (error) {
    console.error("getQuotations error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getQuotationById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }
    const quotation = await AquaQuotation.findById(id)
      .populate("customer", "firstName lastName email phone")
      .populate("products.productId", "title slug photos price");
    if (!quotation) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }
    return res.status(200).json({ success: true, data: quotation });
  } catch (error) {
    console.error("getQuotationById error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getQuotationByNumber = async (req, res) => {
  try {
    const { quotationNo } = req.params;
    const quotation = await AquaQuotation.findOne({ quotationNo })
      .populate("customer", "firstName lastName email phone")
      .populate("products.productId", "title slug photos price");
    if (!quotation) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }
    return res.status(200).json({ success: true, data: quotation });
  } catch (error) {
    console.error("getQuotationByNumber error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getQuotationsByCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;
    if (!isValidObjectId(customerId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer id" });
    }
    const quotations = await AquaQuotation.find({ customer: customerId })
      .sort({ createdAt: -1 })
      .lean();
    return res
      .status(200)
      .json({ success: true, count: quotations.length, data: quotations });
  } catch (error) {
    console.error("getQuotationsByCustomer error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateQuotationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = [
      "Draft",
      "Sent",
      "Accepted",
      "Rejected",
      "Expired",
      "Converted",
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }
    const updated = await AquaQuotation.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true },
    );
    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("updateQuotationStatus error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const QuotationOperations = {
  createQuotation,
  updateQuotation,
  deleteQuotation,
  getQuotations,
  getQuotationById,
  getQuotationByNumber,
  getQuotationsByCustomer,
  updateQuotationStatus,
};

export default QuotationOperations;
