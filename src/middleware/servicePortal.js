import jwt from "jsonwebtoken";

const getServicePin = () => String(process.env.SERVICE_PORTAL_PIN || "").trim();

export const verifyServicePin = (req, res) => {
  const configuredPin = getServicePin();
  if (!configuredPin) {
    return res.status(503).json({
      success: false,
      message: "Service portal PIN is not configured.",
    });
  }

  const suppliedPin = String(req.body?.pin || "").trim();
  if (!suppliedPin || suppliedPin !== configuredPin) {
    return res.status(401).json({
      success: false,
      message: "Incorrect service PIN.",
    });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(503).json({
      success: false,
      message: "Service portal authentication is not configured.",
    });
  }

  const token = jwt.sign(
    { scope: "service-invoice-portal" },
    secret,
    { expiresIn: "8h" },
  );

  return res.status(200).json({
    success: true,
    token,
    expiresInSeconds: 8 * 60 * 60,
  });
};

export const requireServicePortal = (req, res, next) => {
  const raw = req.header("Authorization") || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Service portal authentication required.",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.scope !== "service-invoice-portal") {
      throw new Error("Invalid service token");
    }
    req.servicePortal = true;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Service session expired. Enter the PIN again.",
    });
  }
};

export default {
  verifyServicePin,
  requireServicePortal,
};
