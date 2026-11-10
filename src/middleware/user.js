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

    // With its role, which decides things like unlimited AI chats.
    const user = await AquaEcomUser.findById(decoded._id).populate("roleRef");

    if (!user) {
      console.log("User not found in DB"); // Additional log for missing user
      return res.status(401).json({ message: "User not found" });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Error during token validation or DB lookup:", err); // Log detailed error
    return res.status(401).json({ message: "Token is not valid" });
  }
};

// Why a staff account may not use admin routes, or null when it may.
const adminRejection = (user) => {
  if (user.status === "disabled")
    return { status: 403, message: "Staff account is disabled" };
  if (user.role !== 1 && user.roleRef?.slug !== "super-admin")
    return { status: 403, message: "Admin access required" };
  return null;
};

// A customer token (req.isAdmin = false) or an admin token (req.isAdmin =
// true). Controllers must still check that a customer owns the record.
const customerOrAdmin = async (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token)
    return res
      .status(401)
      .json({ message: "No token provided, authorization denied" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?._id)
      return res.status(401).json({ message: "Token is not valid" });
    const customer = await AquaEcomUser.findById(decoded._id).populate(
      "roleRef",
    );
    if (customer) {
      req.user = customer;
      req.isAdmin = false;
      return next();
    }
    const staff = await AquaAdminUser.findById(decoded._id).populate("roleRef");
    if (!staff) return res.status(401).json({ message: "User not found" });
    const rejection = adminRejection(staff);
    if (rejection)
      return res.status(rejection.status).json({ message: rejection.message });
    req.user = staff;
    req.isAdmin = true;
    return next();
  } catch (err) {
    console.error("Token verification error:", err?.message || err);
    return res.status(401).json({ message: "Token is not valid" });
  }
};

const checkAdmin = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res
        .status(401)
        .json({ message: "No token provided, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded._id) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    const user = await AquaAdminUser.findById(decoded._id).populate("roleRef");

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    const rejection = adminRejection(user);
    if (rejection) {
      return res.status(rejection.status).json({ message: rejection.message });
    }

    req.user = user; // Attach user to request
    next();
  } catch (err) {
    console.error("Token verification error:", err);
    res.status(401).json({ message: "Token is not valid" });
  }
};

const userAuth = {
  isLoggedIn,
  checkAdmin,
  customerOrAdmin,
};

export default userAuth;
