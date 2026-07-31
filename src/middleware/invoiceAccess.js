import { verifyInvoiceAccessToken } from "../utils/invoiceAccess.js";

const requireInvoiceAccess = (req, res, next) => {
  try {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Secure invoice access is required",
      });
    }
    req.invoiceAccess = verifyInvoiceAccessToken(authorization.slice(7).trim());
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invoice access has expired or is invalid",
    });
  }
};

export default requireInvoiceAccess;
