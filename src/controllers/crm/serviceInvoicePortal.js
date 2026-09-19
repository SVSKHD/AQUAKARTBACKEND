import mongoose from "mongoose";
import AquaInvoice from "../../models/crm/invoice.js";

const normalizeQuery = (value = "") => String(value).trim();

const findInvoice = async (req, res) => {
  try {
    const raw = normalizeQuery(req.query.q);
    if (!raw) {
      return res.status(400).json({
        success: false,
        message: "Enter an invoice number, phone or invoice ID.",
      });
    }

    const digits = raw.replace(/\D/g, "");
    const query = {};

    if (mongoose.Types.ObjectId.isValid(raw)) {
      query._id = raw;
    } else if (
      digits.length === 10 ||
      (digits.length === 12 && digits.startsWith("91"))
    ) {
      query["customerDetails.phone"] = Number(
        digits.length === 12 ? digits.slice(2) : digits,
      );
    } else {
      query.invoiceNo = raw;
    }

    const invoice = await AquaInvoice.findOne(query).lean();
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found.",
      });
    }

    return res.status(200).json({
      success: true,
      invoice,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to find invoice.",
    });
  }
};

const getInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid invoice ID.",
      });
    }

    const invoice = await AquaInvoice.findById(id).lean();
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found.",
      });
    }

    return res.status(200).json({
      success: true,
      invoice,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to load invoice.",
    });
  }
};

export default { findInvoice, getInvoice };
