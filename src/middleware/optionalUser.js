import jwt from "jsonwebtoken";
import AquaEcomUser from "../models/user.js";

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

    const user = await AquaEcomUser.findById(decoded._id);
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
