import { GstinLookupError, lookupGstin } from "../../services/gstinLookup.js";

/**
 * GET /v1/crm/admin/gstin/:gstin
 * Returns the GST portal record (legal/trade name, status, principal address)
 * for a GSTIN, via Masters India. Staff only; read-only.
 */
const lookup = async (req, res) => {
  try {
    const data = await lookupGstin(req.params.gstin);
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof GstinLookupError)
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    console.error("GSTIN lookup failed:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "GST lookup failed. Try again.",
      code: "GSTIN_LOOKUP_FAILED",
    });
  }
};

const GstinLookupOperations = { lookup };
export default GstinLookupOperations;
