import mongoose from "mongoose";
import { nanoid } from "nanoid";
import AquaInvoice from "../../models/crm/invoice.js";
import AquaProduct from "../../models/product.js";
import NotificationLog from "../../models/crm/notificationLog.js";
import sendWhatsAppMessage from "../../notifications/phone/sendWhatsapp.js";

const INDIAN_CONTACT_REGEX = /^(?:\+91|91)?[6-9]\d{9}$/;
const normalizeIndianPhone = (phone) =>
  String(phone || "")
    .replace(/\s|-/g, "")
    .replace(/^\+91/, "")
    .replace(/^91/, "");

const validateInvoicePayload = (payload = {}) => {
  const errors = {};
  const customerName = payload?.customerDetails?.name;
  const customerPhone = payload?.customerDetails?.phone;
  const products = payload?.products;
  const gstEnabled = payload?.gst === true;

  if (!customerName || typeof customerName !== "string" || !customerName.trim())
    errors["customerDetails.name"] = "Customer name is required";
  if (
    customerPhone === undefined ||
    customerPhone === null ||
    String(customerPhone).trim() === ""
  ) {
    errors["customerDetails.phone"] = "Customer phone is required";
  } else if (
    !INDIAN_CONTACT_REGEX.test(String(customerPhone).replace(/\s|-/g, ""))
  ) {
    errors["customerDetails.phone"] =
      "Customer phone must be a valid Indian contact number";
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
      )
        errors[`${path}.productName`] = "Product name is required";
      if (
        product?.productQuantity === undefined ||
        product?.productQuantity === null ||
        product.productQuantity === ""
      )
        errors[`${path}.productQuantity`] = "Product quantity is required";
      else if (Number(product.productQuantity) <= 0)
        errors[`${path}.productQuantity`] =
          "Product quantity must be greater than 0";
      if (
        product?.productPrice === undefined ||
        product?.productPrice === null ||
        product.productPrice === ""
      )
        errors[`${path}.productPrice`] = "Product price is required";
      else if (Number(product.productPrice) < 0)
        errors[`${path}.productPrice`] = "Product price must be at least 0";
    });
  }

  if (gstEnabled) {
    const gstNo = payload?.gstDetails?.gstNo;
    const gstName = payload?.gstDetails?.gstName;
    if (!gstNo || typeof gstNo !== "string" || !gstNo.trim())
      errors["gstDetails.gstNo"] = "GST number is required when gst is true";
    if (!gstName || typeof gstName !== "string" || !gstName.trim())
      errors["gstDetails.gstName"] = "GST name is required when gst is true";
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

const collectProductQuantities = (products = []) => {
  const quantityByProductId = new Map();

  if (!Array.isArray(products)) return quantityByProductId;

  products.forEach((product) => {
    const productId = product?.productId ? String(product.productId) : "";
    const quantity = Number(product?.productQuantity || 0);

    // Manual invoice rows without productId should not affect product collection stock.
    if (!productId || !mongoose.Types.ObjectId.isValid(productId) || quantity <= 0)
      return;

    quantityByProductId.set(
      productId,
      (quantityByProductId.get(productId) || 0) + quantity,
    );
  });

  return quantityByProductId;
};

const buildProductStockChanges = (newProducts = [], oldProducts = []) => {
  const newQuantities = collectProductQuantities(newProducts);
  const oldQuantities = collectProductQuantities(oldProducts);
  const productIds = new Set([...newQuantities.keys(), ...oldQuantities.keys()]);

  return [...productIds]
    .map((productId) => {
      const oldQuantity = oldQuantities.get(productId) || 0;
      const newQuantity = newQuantities.get(productId) || 0;

      // Positive delta returns stock. Negative delta consumes stock.
      return { productId, stockDelta: oldQuantity - newQuantity };
    })
    .filter(({ stockDelta }) => stockDelta !== 0);
};

const assertStockAvailable = async (stockChanges = []) => {
  const consumingChanges = stockChanges.filter(({ stockDelta }) => stockDelta < 0);
  if (!consumingChanges.length) return;

  const products = await AquaProduct.find({
    _id: { $in: consumingChanges.map(({ productId }) => productId) },
  }).select("_id title stock");

  const productById = new Map(
    products.map((product) => [String(product._id), product]),
  );

  const stockErrors = [];

  consumingChanges.forEach(({ productId, stockDelta }) => {
    const product = productById.get(productId);
    const requiredQuantity = Math.abs(stockDelta);

    if (!product) {
      stockErrors.push({ productId, message: "Product not found" });
      return;
    }

    if (Number(product.stock || 0) < requiredQuantity) {
      stockErrors.push({
        productId,
        productName: product.title,
        availableStock: Number(product.stock || 0),
        requiredQuantity,
        message: "Insufficient stock",
      });
    }
  });

  if (stockErrors.length) {
    const error = new Error("Insufficient product stock");
    error.statusCode = 400;
    error.errors = stockErrors;
    throw error;
  }
};

const applyProductStockChanges = async (stockChanges = []) => {
  const operations = stockChanges.map(({ productId, stockDelta }) => ({
    updateOne: {
      filter: { _id: productId },
      update: { $inc: { stock: stockDelta } },
    },
  }));

  if (!operations.length) return null;

  return AquaProduct.bulkWrite(operations);
};

const rollbackProductStockChanges = async (stockChanges = []) => {
  const rollbackChanges = stockChanges.map(({ productId, stockDelta }) => ({
    productId,
    stockDelta: stockDelta * -1,
  }));

  return applyProductStockChanges(rollbackChanges);
};

const createInvoice = async (req, res) => {
  let stockChanges = [];
  let stockUpdated = false;

  try {
    const { isValid, errors } = validateInvoicePayload(req.body);
    if (!isValid)
      return res
        .status(400)
        .json({ status: false, message: "Validation failed", errors });

    stockChanges = buildProductStockChanges(req.body.products, []);
    await assertStockAvailable(stockChanges);
    await applyProductStockChanges(stockChanges);
    stockUpdated = true;

    const uniqueId = nanoid(10);
    const now = new Date();
    const formattedDate = now.toISOString().split("T")[0];
    req.body.invoiceNo = `AQB${uniqueId}|${now.getDate()}${now.getMonth() + 1}${now.getFullYear()}`;
    req.body.createdAt = formattedDate;
    req.body.updatedAt = formattedDate;
    req.body.date = formattedDate;
    req.body.transport = req.body.transport || {};
    req.body.transport.deliveryDate = formattedDate;

    const savedInvoice = await new AquaInvoice(req.body).save();
    res.status(201).json(savedInvoice);
  } catch (error) {
    if (stockUpdated) await rollbackProductStockChanges(stockChanges);
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: false,
      message: error.statusCode ? error.message : "Server Error",
      errors: error.errors,
      error,
    });
  }
};

const updateInvoice = async (req, res) => {
  let stockChanges = [];
  let stockUpdated = false;

  try {
    const { id } = req.params;
    const invoice = await AquaInvoice.findById(id);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const { isValid, errors } = validateInvoicePayload(req.body);
    if (!isValid)
      return res
        .status(400)
        .json({ status: false, message: "Validation failed", errors });

    stockChanges = buildProductStockChanges(req.body.products, invoice.products);
    await assertStockAvailable(stockChanges);
    await applyProductStockChanges(stockChanges);
    stockUpdated = true;

    req.body.invoiceNo = invoice.invoiceNo;
    req.body.createdAt = invoice.createdAt;
    req.body.updatedAt = new Date().toISOString().split("T")[0];
    req.body.date = invoice.date;
    req.body.transport = req.body.transport || {};
    req.body.transport.deliveryDate = invoice.transport?.deliveryDate;

    const updatedInvoice = await AquaInvoice.findByIdAndUpdate(id, req.body, {
      new: true,
    });

    if (!updatedInvoice) {
      await rollbackProductStockChanges(stockChanges);
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.status(200).json(updatedInvoice);
  } catch (error) {
    if (stockUpdated) await rollbackProductStockChanges(stockChanges);
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: false,
      message: error.statusCode ? error.message : "Server Error",
      errors: error.errors,
      error,
    });
  }
};

const deleteInvoice = async (req, res) => {
  let stockChanges = [];
  let stockUpdated = false;

  try {
    const invoice = await AquaInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    stockChanges = buildProductStockChanges([], invoice.products);
    await applyProductStockChanges(stockChanges);
    stockUpdated = true;

    const deletedInvoice = await AquaInvoice.findByIdAndDelete(req.params.id);
    if (!deletedInvoice) {
      await rollbackProductStockChanges(stockChanges);
      return res.status(404).json({ message: "Invoice not found" });
    }

    res
      .status(200)
      .json({ status: true, message: "Invoice deleted successfully" });
  } catch (error) {
    if (stockUpdated) await rollbackProductStockChanges(stockChanges);
    res.status(500).json({ message: "Server Error", error });
  }
};

const getInvoices = async (req, res) => {
  try {
    const { gst, po, search, user } = req.query;
    const filter = {};
    if (gst === "true") filter.gst = true;
    if (po === "true") filter.po = true;
    if (user === "true") filter.gst = false;
    if (search) {
      filter.$or = [
        { invoiceNo: { $regex: search, $options: "i" } },
        { "customerDetails.name": { $regex: search, $options: "i" } },
      ];
    }
    const invoices = await AquaInvoice.find(filter)
      .sort({ createdAt: -1 })
      .lean();
    return res
      .status(200)
      .json({ status: true, data: invoices, no: invoices.length });
  } catch (error) {
    return res
      .status(400)
      .json({ status: false, message: "Sorry, please try again" });
  }
};

const getInvoice = async (req, res) => {
  try {
    const { id, name, phone, invoiceNo, gstNo } = req.query;
    const query = {};
    if (id) query._id = id;
    if (name) query["customerDetails.name"] = new RegExp(name, "i");
    if (phone) query["customerDetails.phone"] = phone;
    if (invoiceNo) query.invoiceNo = invoiceNo;
    if (gstNo) query["gstDetails.gstNo"] = gstNo;
    res.status(200).json(await AquaInvoice.findOne(query));
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid invoice id" });
    const invoice = await AquaInvoice.findById(id);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
};

const getInvoiceByPhone = async (req, res) => {
  try {
    res
      .status(200)
      .json(
        await AquaInvoice.find({ "customerDetails.phone": req.params.phone }),
      );
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
};

const getInvoicesByDate = async (req, res) => {
  try {
    const { month, year, startDate, endDate } = req.query;
    const query = {};
    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      const [day, month, year] = dateStr.split("-").map(Number);
      const fullYear = year < 100 ? 2000 + year : year;
      return new Date(fullYear, month - 1, day);
    };
    const parsedStartDate = parseDate(startDate);
    const parsedEndDate = parseDate(endDate);
    if (month) {
      const resolvedYear = year || new Date().getFullYear();
      const monthIndex = new Date(`${month} 1, ${resolvedYear}`).getMonth();
      const s = new Date(resolvedYear, monthIndex, 1);
      const e = new Date(resolvedYear, monthIndex + 1, 0, 23, 59, 59);
      query.createdAt = { $gte: s.toISOString(), $lte: e.toISOString() };
    } else if (year && !month) {
      const s = new Date(year, 1, 1);
      const e = new Date(year, 11, 31, 23, 59, 59);
      query.createdAt = { $gte: s.toISOString(), $lte: e.toISOString() };
    } else if (parsedStartDate && !parsedEndDate) {
      const s = new Date(
        parsedStartDate.getFullYear(),
        parsedStartDate.getMonth(),
        1,
      );
      const e = new Date(
        parsedStartDate.getFullYear(),
        parsedStartDate.getMonth() + 1,
        0,
        23,
        59,
        59,
      );
      query.createdAt = { $gte: s.toISOString(), $lte: e.toISOString() };
    } else if (parsedStartDate && parsedEndDate) {
      query.createdAt = {
        $gte: parsedStartDate.toISOString(),
        $lte: new Date(parsedEndDate.setHours(23, 59, 59)).toISOString(),
      };
    } else {
      const today = new Date();
      const s = new Date(today.setHours(0, 0, 0, 0));
      const e = new Date(today.setHours(23, 59, 59));
      query.createdAt = { $gte: s.toISOString(), $lte: e.toISOString() };
    }
    const invoices = await AquaInvoice.find(query);
    res
      .status(200)
      .json({ success: true, data: invoices, no: invoices.length });
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
};

const notifySpecificInvoiceMember = async (req, res) => {
  try {
    const invoice = await AquaInvoice.findById(req.params.id).lean();
    if (!invoice)
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    const { name, phone } = invoice.customerDetails || {};
    if (!phone)
      return res
        .status(400)
        .json({ success: false, message: "Invoice has no customer phone" });
    const message =
      req.body?.message ||
      `Dear ${name || "Customer"}, your invoice ${invoice.invoiceNo} dated ${invoice.date} is available at https://admin.aquakart.co.in/invoice/${invoice._id}.`;
    const delivery = await sendWhatsAppMessage(
      normalizeIndianPhone(phone),
      message,
    );
    await NotificationLog.create({
      invoiceId: invoice._id,
      phone: normalizeIndianPhone(phone),
      message,
      status: delivery?.status ? "sent" : "failed",
      response: delivery,
    });
    return res
      .status(200)
      .json({ success: true, message: "Notification sent", delivery });
  } catch (error) {
    await NotificationLog.create({
      invoiceId: req.params.id,
      phone: req.body?.phone || "",
      message: req.body?.message || "",
      status: "failed",
      response: error?.error || error?.message || error,
    });
    return res
      .status(500)
      .json({ success: false, message: "Failed to send notification", error });
  }
};

const NotifyInvoiceMembers = async (req, res) => {
  try {
    const invoices = await AquaInvoice.find({}).lean();
    const data = req.body;
    const year = new Date().getFullYear();
    if (data.send !== "all" || !data.festival)
      return res
        .status(400)
        .json({ error: "Festival name and send=all are required." });
    const results = [];
    for (const invoice of invoices) {
      const { name: customerName, phone } = invoice.customerDetails || {};
      if (!phone) continue;
      const message = `Dear ${customerName}, we wish you a very happy ${data.festival} ${year}! 🎉 Your invoice ${invoice.invoiceNo} dated ${invoice.date} for Rs.${invoice.totalAmount} is available at https://admin.aquakart.co.in/invoice/${invoice._id}.`;
      try {
        const delivery = await sendWhatsAppMessage(
          normalizeIndianPhone(phone),
          message,
        );
        await NotificationLog.create({
          invoiceId: invoice._id,
          phone: normalizeIndianPhone(phone),
          message,
          status: "sent",
          response: delivery,
        });
        results.push({ invoiceId: invoice._id, status: "sent" });
      } catch (err) {
        await NotificationLog.create({
          invoiceId: invoice._id,
          phone: normalizeIndianPhone(phone),
          message,
          status: "failed",
          response: err?.error || err?.message || err,
        });
        results.push({ invoiceId: invoice._id, status: "failed" });
      }
    }
    return res.json({
      success: true,
      message: "Notifications processed",
      resultsCount: results.length,
      results,
    });
  } catch (error) {
    return res.status(500).json({ error: "Internal server error." });
  }
};

export default {
  createInvoice,
  updateInvoice,
  getInvoice,
  getInvoices,
  deleteInvoice,
  getInvoiceById,
  getInvoiceByPhone,
  getInvoicesByDate,
  NotifyInvoiceMembers,
  notifySpecificInvoiceMember,
};
