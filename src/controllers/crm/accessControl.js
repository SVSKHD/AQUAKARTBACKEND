import mongoose from "mongoose";
import Role from "../../models/crm/role.js";
import Staff from "../../models/crm/adminUser.js";
import AuditLog from "../../models/crm/auditLog.js";
import { PERMISSIONS, SUPER_ADMIN_ROLE } from "../../constants/permissions.js";
import { staffHasPermission } from "../../middleware/permissions.js";
import { writeAudit } from "../../services/audit.js";

const safeStaff = (staff) => {
  const value = staff.toObject ? staff.toObject() : { ...staff };
  [
    "password",
    "resetPasswordOtp",
    "confirmationOtp",
    "mobileOtp",
    "emailOtp",
    "otp",
  ].forEach((field) => delete value[field]);
  return value;
};

export const listPermissions = (_req, res) =>
  res.json({ success: true, data: PERMISSIONS });

export const listRoles = async (_req, res) => {
  const roles = await Role.find({}).sort({ isSystem: -1, name: 1 }).lean();
  return res.json({ success: true, data: roles });
};

export const createRole = async (req, res) => {
  try {
    const requested = [...new Set(req.body.permissions || [])];
    if (requested.some((permission) => !PERMISSIONS.includes(permission))) {
      return res
        .status(400)
        .json({ success: false, message: "Unknown permission supplied" });
    }
    if (
      requested.some((permission) => !staffHasPermission(req.user, permission))
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Cannot grant a permission you do not possess",
        });
    }
    const role = await Role.create({
      name: req.body.name,
      slug: req.body.slug || req.body.name,
      description: req.body.description,
      permissions: requested,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await writeAudit({
      req,
      action: "role.create",
      resourceType: "role",
      resourceId: role._id,
      after: role,
    });
    return res.status(201).json({ success: true, data: role });
  } catch (error) {
    return res
      .status(error?.code === 11000 ? 409 : 400)
      .json({ success: false, message: error.message });
  }
};

export const updateRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role)
      return res
        .status(404)
        .json({ success: false, message: "Role not found" });
    if (role.slug === SUPER_ADMIN_ROLE || role.isSystem) {
      return res
        .status(409)
        .json({ success: false, message: "System roles cannot be modified" });
    }
    const before = role.toObject();
    const allowed = ["name", "description", "permissions", "isActive"];
    allowed.forEach((field) => {
      if (req.body[field] !== undefined) role[field] = req.body[field];
    });
    if (
      role.permissions.some((permission) => !PERMISSIONS.includes(permission))
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Unknown permission supplied" });
    }
    if (
      role.permissions.some(
        (permission) => !staffHasPermission(req.user, permission),
      )
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Cannot grant a permission you do not possess",
        });
    }
    role.updatedBy = req.user._id;
    await role.save();
    await writeAudit({
      req,
      action: "role.update",
      resourceType: "role",
      resourceId: role._id,
      before,
      after: role,
    });
    return res.json({ success: true, data: role });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const archiveRole = async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role)
    return res.status(404).json({ success: false, message: "Role not found" });
  if (role.isSystem || role.slug === SUPER_ADMIN_ROLE) {
    return res
      .status(409)
      .json({ success: false, message: "System roles cannot be archived" });
  }
  if (await Staff.exists({ roleRef: role._id, status: "active" })) {
    return res
      .status(409)
      .json({
        success: false,
        message: "Reassign active staff before archiving this role",
      });
  }
  role.isActive = false;
  role.updatedBy = req.user._id;
  await role.save();
  await writeAudit({
    req,
    action: "role.archive",
    resourceType: "role",
    resourceId: role._id,
    after: role,
  });
  return res.json({ success: true, data: role });
};

export const listStaff = async (_req, res) => {
  const staff = await Staff.find({})
    .populate("roleRef")
    .sort({ createdAt: -1 });
  return res.json({ success: true, data: staff.map(safeStaff) });
};

export const createStaff = async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.body.roleId, isActive: true });
    if (!role)
      return res
        .status(400)
        .json({ success: false, message: "Active role is required" });
    if (
      role.permissions.some(
        (permission) => !staffHasPermission(req.user, permission),
      )
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Cannot assign a role above your permissions",
        });
    }
    const staff = await Staff.create({
      email: req.body.email,
      password: req.body.password,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      phone: req.body.phone,
      roleRef: role._id,
      role: role.slug === SUPER_ADMIN_ROLE ? 1 : 3,
      status: "active",
    });
    await writeAudit({
      req,
      action: "staff.create",
      resourceType: "staff",
      resourceId: staff._id,
      after: safeStaff(staff),
    });
    return res.status(201).json({ success: true, data: safeStaff(staff) });
  } catch (error) {
    return res
      .status(error?.code === 11000 ? 409 : 400)
      .json({ success: false, message: error.message });
  }
};

export const updateStaff = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id))
    return res
      .status(400)
      .json({ success: false, message: "Invalid staff id" });
  const staff = await Staff.findById(req.params.id).populate("roleRef");
  if (!staff)
    return res.status(404).json({ success: false, message: "Staff not found" });
  if (
    staff.roleRef?.slug === SUPER_ADMIN_ROLE &&
    String(staff._id) !== String(req.user._id)
  ) {
    return res
      .status(403)
      .json({
        success: false,
        message: "Another super-admin cannot be changed",
      });
  }
  const before = safeStaff(staff);
  for (const field of ["firstName", "lastName", "phone"]) {
    if (req.body[field] !== undefined) staff[field] = req.body[field];
  }
  if (req.body.password) staff.password = req.body.password;
  if (req.body.roleId) {
    const role = await Role.findOne({ _id: req.body.roleId, isActive: true });
    if (!role)
      return res
        .status(400)
        .json({ success: false, message: "Active role is required" });
    if (
      role.permissions.some(
        (permission) => !staffHasPermission(req.user, permission),
      )
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Cannot assign a role above your permissions",
        });
    }
    staff.roleRef = role._id;
    staff.role = role.slug === SUPER_ADMIN_ROLE ? 1 : 3;
  }
  await staff.save();
  await writeAudit({
    req,
    action: "staff.update",
    resourceType: "staff",
    resourceId: staff._id,
    before,
    after: safeStaff(staff),
  });
  return res.json({ success: true, data: safeStaff(staff) });
};

export const updateStaffStatus = async (req, res) => {
  if (!["active", "disabled"].includes(req.body.status))
    return res.status(400).json({ success: false, message: "Invalid status" });
  if (
    String(req.params.id) === String(req.user._id) &&
    req.body.status === "disabled"
  ) {
    return res
      .status(409)
      .json({ success: false, message: "You cannot disable your own account" });
  }
  const staff = await Staff.findById(req.params.id).populate("roleRef");
  if (!staff)
    return res.status(404).json({ success: false, message: "Staff not found" });
  if (
    staff.roleRef?.slug === SUPER_ADMIN_ROLE &&
    req.body.status === "disabled"
  ) {
    const other = await Staff.countDocuments({
      _id: { $ne: staff._id },
      status: "active",
    });
    if (!other)
      return res
        .status(409)
        .json({
          success: false,
          message: "The final active administrator cannot be disabled",
        });
  }
  const before = safeStaff(staff);
  staff.status = req.body.status;
  await staff.save();
  await writeAudit({
    req,
    action: "staff.status",
    resourceType: "staff",
    resourceId: staff._id,
    before,
    after: safeStaff(staff),
  });
  return res.json({ success: true, data: safeStaff(staff) });
};

export const listAuditLogs = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = {};
  if (req.query.resourceType) filter.resourceType = req.query.resourceType;
  const [data, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};
