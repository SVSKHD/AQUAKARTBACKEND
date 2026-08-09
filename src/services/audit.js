import AuditLog from "../models/crm/auditLog.js";

export const writeAudit = async ({
  req,
  action,
  resourceType,
  resourceId,
  before,
  after,
  metadata,
}) => {
  try {
    await AuditLog.create({
      actorId: req?.user?._id,
      action,
      resourceType,
      resourceId: resourceId ? String(resourceId) : undefined,
      before,
      after,
      metadata,
      ip: req?.ip,
      userAgent: req?.get?.("user-agent"),
    });
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
};
