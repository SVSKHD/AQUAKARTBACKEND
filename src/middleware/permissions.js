import jwt from "jsonwebtoken";
import AquaAdminUser from "../models/crm/adminUser.js";
import { SUPER_ADMIN_ROLE } from "../constants/permissions.js";

export const authenticateStaff = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token)
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await AquaAdminUser.findById(decoded._id).populate("roleRef");
    if (!user || user.status === "disabled") {
      return res
        .status(401)
        .json({ success: false, message: "Staff account is unavailable" });
    }
    req.user = user;
    next();
  } catch (_error) {
    return res
      .status(401)
      .json({ success: false, message: "Token is not valid" });
  }
};

export const staffHasPermission = (user, permission) => {
  if (user?.roleRef?.slug === SUPER_ADMIN_ROLE) return true;
  // Backward compatibility for existing numeric administrators until migrated.
  if (!user?.roleRef && user?.role === 1) return true;
  return Boolean(
    user?.directPermissions?.includes(permission) ||
    (user?.roleRef?.isActive && user.roleRef.permissions?.includes(permission)),
  );
};

export const requirePermission = (...permissions) => [
  authenticateStaff,
  (req, res, next) => {
    if (
      permissions.every((permission) =>
        staffHasPermission(req.user, permission),
      )
    )
      return next();
    return res
      .status(403)
      .json({
        success: false,
        message: "Insufficient permission",
        required: permissions,
      });
  },
];
