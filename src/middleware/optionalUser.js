import jwt from "jsonwebtoken";
import AquaEcomUser from "../models/user.js";
import {
  isSessionRevoked,
  REVOKED_MESSAGE,
} from "../services/auth/sessionRevocation.js";

const optionalUserAuth = async (req, res, next) => {
  const authorization = req.header("Authorization");

  if (!authorization) {
    req.user = null;
    return next();
  }

  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === authorization) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "Invalid authorization header",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?._id) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        message: "Token is not valid",
      });
    }

    // With its role, which decides things like unlimited AI chats.
    const [user, revoked] = await Promise.all([
      AquaEcomUser.findById(decoded._id).populate("roleRef"),
      isSessionRevoked(token),
    ]);
    if (revoked) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        code: "SESSION_REVOKED",
        message: REVOKED_MESSAGE,
      });
    }
    if (!user) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        message: "User not found",
      });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: "Token is not valid",
    });
  }
};

export default optionalUserAuth;
