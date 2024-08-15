import jwt from "jsonwebtoken";
import AquaEcomUser from "../models/user.js";
import AquaAdminUser from "../models/crm/adminUser.js";

const isLoggedIn = async (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    return res
      .status(401)
      .json({ message: "No token provided, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded._id) {
      return res.status(401).json({ message: "Token is not valid" });
    }

    req.user = decoded;
    const user = await AquaEcomUser.findById(decoded._id);

    console.log("Decoded token:", decoded); // Log decoded token
    console.log("Fetched user from DB:", user); // Log fetched user

    if (!user) {
      console.log("User not found in DB"); // Additional log for missing user
      return res.status(401).json({ message: "User not found" });
    }

    next();
  } catch (err) {
    console.error("Error during token validation or DB lookup:", err); // Log detailed error
    return res.status(401).json({ message: "Token is not valid" });
  }
};

const checkAdmin = async (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    return res
      .status(401)
      .json({ message: "No token provided, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded._id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    const user = await AquaAdminUser.findById(decoded._id);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (user.role !== 1) {
      return res.status(403).json({ message: "Admin access required" });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Token verification error:", err); // Debug log
    res.status(401).json({ message: "Token is not valid" });
  }
};

const userAuth = {
  isLoggedIn,
  checkAdmin,
};

export default userAuth;
