import mongoose from "mongoose";
import AquaQuotation from "../../models/crm/quotation.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const formatDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const getTodayIsoDate = () => new Date().toISOString().split("T")[0];

const getNextQuotationNo = async () => {
  const dateKey = formatDateKey();
  const prefix = `AQUO|${dateKey}|`;
  const lastQuotation = await AquaQuotation.findOne({
    quotationNo: { $regex: `^${prefix}` },
  })
    .sort({ createdAt: -1 })
    .select("quotationNo")
    .lean();

  const lastSerial = Number(lastQuotation?.quotationNo?.split("|")?.[2]) || 0;
  const nextSerial = String(lastSerial + 1).padStart(4, "0");
  return `${prefix}${nextSerial}`;
};

const calculateTotals = (payload = {}) => {
  const products = Array.isArray(payload.products) ? payload.products : [];
  let subTotal = 0;

  const calculatedProducts = products.map((product) => {
    const quantity = Number(product.productQuantity) || 0;
    const price = Number(product.productPrice) || 0;
    const discount = Number(product.productDiscount) || 0;
    const tax = Number(product.productTax) || 0;
    const productTotal = Math.max(quantity * price - discount, 0) + tax;
    subTotal += productTotal;
    return { ...product, productTotal };
  });

  const discount = Number(payload.discount) || 0;
  const tax = Number(payload.tax) || 0;
  const totalAmount = Math.max(subTotal - discount, 0) + tax;

  return {
    products: calculatedProducts,
    subTotal,
    discount,
    tax,
    totalAmount,
  };
};

const validateQuotationPayload = (payload = {}) => {
  const errors = {};

  if (!payload.customerDetails?.name?.trim()) {
    errors["customerDetails.name"] = "Customer name is required";
  }

  if (
    payload.customerDetails?.phone === undefined ||
    payload.customerDetails?.phone === null ||
    String(payload.customerDetails.phone).trim() === ""
  ) {
    errors["customerDetails.phone"] = "Customer phone is required";
  }

  if (!Array.isArray(payload.products) || payload.products.length === 0) {
    errors.products = "At least one product is required";
  } else {
    payload.products.forEach((product, index) => {
      const field = `products[${index}]`;
      if (!product.productName?.trim()) {
        errors[`${field}.productName`] = "Product name is required";
      }
      if (Number(product.productQuantity) <= 0) {
        errors[`${field}.productQuantity`] =
          "Product quantity must be greater than 0";
      }
      if (Number(product.productPrice) < 0) {
        errors[`${field}.productPrice`] = "Product price must be at least 0";
      }
    });
  }

  if (payload.gst === true) {
    if (!payload.gstDetails?.gstName?.trim()) {
      errors["gstDetails.gstName"] = "GST name is required when GST is enabled";
    }
    if (!payload.gstDetails?.gstNo?.trim()) {
      errors["gstDetails.gstNo"] = "GST number is required when GST is enabled";
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

const buildQuotationPayload = async (body = {}, existingQuotation = null) => {
  const totals = calculateTotals(body);
  const amountPaid = Number(body.payment?.amountPaid) || 0;
  const balanceAmount = Math.max(totals.totalAmount - amountPaid, 0);

  let paymentStatus = body.payment?.status || "Unpaid";
  if (amountPaid > 0 && amountPaid < totals.totalAmount) paymentStatus = "Partial";
  if (amountPaid >= totals.totalAmount && totals.totalAmount > 0) paymentStatus = "Paid";

  const status =
    body.status ||
    (paymentStatus === "Paid"
      ? "Paid"
      : paymentStatus === "Partial"
        ? "Payment Pending"
        : existingQuotation?.status || "Draft");

  return {
    ...body,
    ...totals,
    quotationNo: existingQuotation?.quotationNo || body.quotationNo || (await getNextQuotationNo()),
    date: existingQuotation?.date || body.date || getTodayIsoDate(),
    status,
    payment: {
      ...body.payment,
      status: paymentStatus,
      amountPaid,
      balanceAmount,
    },
  };
};

const createQuotation = async (req, res) => {
  try {
    const { isValid, errors } = validateQuotationPayload(req.body);
    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    const payload = await buildQuotationPayload(req.body);
    payload.createdBy = req.user?._id;

    const quotation = await AquaQuotation.create(payload);
    return res.status(201).json({ success: true, data: quotation });
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

const getQuotations = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const skip = (page - 1) * limit;
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.paymentStatus) filter["payment.status"] = req.query.paymentStatus;
    if (req.query.gst === "true") filter.gst = true;
    if (req.query.gst === "false") filter.gst = false;
    if (req.query.customer && isValidObjectId(req.query.customer)) {
      filter.customer = req.query.customer;
    }

    if (req.query.search) {
      const searchRegex = new RegExp(String(req.query.search).trim(), "i");
      filter.$or = [
        { quotationNo: searchRegex },
        { "customerDetails.name": searchRegex },
        { "customerDetails.email": searchRegex },
        { "customerDetails.phone": searchRegex },
        { "gstDetails.gstNo": searchRegex },
      ];
    }

    const [quotations, total] = await Promise.all([
      AquaQuotation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("customer", "firstName lastName email phone")
        .populate("convertedToInvoice", "invoiceNo date")
        .lean(),
      AquaQuotation.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: quotations,
      count: quotations.length,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    console.error("getQuotations error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getQuotationById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }

    const quotation = await AquaQuotation.findById(req.params.id)
      .populate("customer", "firstName lastName email phone")
      .populate("convertedToInvoice", "invoiceNo date")
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
    const quotation = await AquaQuotation.findOne({
      quotationNo: req.params.quotationNo,
    })
      .populate("customer", "firstName lastName email phone")
      .populate("convertedToInvoice", "invoiceNo date")
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
    if (!isValidObjectId(req.params.customerId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid customer id" });
    }

    const quotations = await AquaQuotation.find({ customer: req.params.customerId })
      .sort({ createdAt: -1 })
      .populate("convertedToInvoice", "invoiceNo date")
      .lean();

    return res.status(200).json({
      success: true,
      data: quotations,
      count: quotations.length,
    });
  } catch (error) {
    console.error("getQuotationsByCustomer error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateQuotation = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }

    const existingQuotation = await AquaQuotation.findById(req.params.id);
    if (!existingQuotation) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }

    if (existingQuotation.convertedToInvoice) {
      return res.status(409).json({
        success: false,
        message: "Converted quotation cannot be edited",
      });
    }

    const { isValid, errors } = validateQuotationPayload(req.body);
    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    const payload = await buildQuotationPayload(req.body, existingQuotation);
    delete payload._id;
    delete payload.createdAt;
    delete payload.convertedToInvoice;
    delete payload.convertedToOrder;

    const quotation = await AquaQuotation.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    return res.status(200).json({ success: true, data: quotation });
  } catch (error) {
    console.error("updateQuotation error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateQuotationStatus = async (req, res) => {
  try {
    const allowedStatus = [
      "Draft",
      "Sent",
      "Accepted",
      "Rejected",
      "Expired",
      "Payment Pending",
      "Paid",
      "Converted",
    ];

    if (!allowedStatus.includes(req.body.status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }

    const quotation = await AquaQuotation.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true, runValidators: true },
    ).populate("convertedToInvoice", "invoiceNo date");

    if (!quotation) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }

    return res.status(200).json({ success: true, data: quotation });
  } catch (error) {
    console.error("updateQuotationStatus error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteQuotation = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid quotation id" });
    }

    const quotation = await AquaQuotation.findById(req.params.id);
    if (!quotation) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found" });
    }

    if (quotation.convertedToInvoice) {
      return res.status(409).json({
        success: false,
        message: "Converted quotation cannot be deleted",
      });
    }

    await quotation.deleteOne();
    return res
      .status(200)
      .json({ success: true, message: "Quotation deleted successfully" });
  } catch (error) {
    console.error("deleteQuotation error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateQuotationPayment = async (_req, res) => {
  return res.status(501).json({
    success: false,
    message: "Quotation payment API will be enabled after CRUD frontend mapping",
  });
};

const convertQuotationToInvoice = async (_req, res) => {
  return res.status(501).json({
    success: false,
    message: "Quotation invoice conversion API will be enabled after payment flow",
  });
};

export default {
  createQuotation,
  getQuotations,
  getQuotationById,
  getQuotationByNumber,
  getQuotationsByCustomer,
  updateQuotation,
  updateQuotationStatus,
  deleteQuotation,
  updateQuotationPayment,
  convertQuotationToInvoice,
};
