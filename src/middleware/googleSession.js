import jwt from "jsonwebtoken";
import AquaEcomUser from "../models/user.js";

const requireGoogleBackendSession = async (req, res, next) => {
  const sessionToken = String(req.get("x-aquakart-session") || "").trim();
  if (!sessionToken) {
    return res.status(401).json({
      success: false,
      message: "Complete Google sign-in before searching for invoices",
    });
  }

  try {
    const decoded = jwt.verify(sessionToken, process.env.JWT_SECRET);
    if (!decoded?._id) throw new Error("Invalid session");
    const user = await AquaEcomUser.findById(decoded._id).select(
      "firebaseUid email emailVerified isEmailVerfied",
    );
    if (
      !user ||
      !user.firebaseUid ||
      String(user.firebaseUid) !== String(req.firebaseUser?.uid)
    ) {
      return res.status(401).json({
        success: false,
        message: "Your Google session could not be verified",
      });
    }
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Your Aquakart session is invalid or expired",
    });
  }
};

export default requireGoogleBackendSession;
