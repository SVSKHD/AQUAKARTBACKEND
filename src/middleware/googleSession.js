import jwt from "jsonwebtoken";
import AquaEcomUser from "../models/user.js";
import {
  isSessionRevoked,
  REVOKED_MESSAGE,
} from "../services/auth/sessionRevocation.js";

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
    const [user, revoked] = await Promise.all([
      AquaEcomUser.findById(decoded._id).select(
        "firebaseUid email emailVerified isEmailVerfied",
      ),
      isSessionRevoked(sessionToken),
    ]);
    if (revoked) {
      return res.status(401).json({
        success: false,
        code: "SESSION_REVOKED",
        message: REVOKED_MESSAGE,
      });
    }
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
