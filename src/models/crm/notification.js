import mongoose from "mongoose";

export const CRM_NOTIFICATION_SEVERITIES = [
  "info",
  "success",
  "warning",
  "critical",
];

const crmNotificationSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true, index: true },
    entityType: {
      type: String,
      required: true,
      trim: true,
      enum: [
        "order",
        "invoice",
        "customer",
        "quotation",
        "payment",
        "review",
        "stock",
        "service-reminder",
        "system",
      ],
      index: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    severity: {
      type: String,
      enum: CRM_NOTIFICATION_SEVERITIES,
      default: "info",
      index: true,
    },
    eventKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    readBy: [
      {
        _id: false,
        adminId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "AquaAdminUser",
          required: true,
        },
        readAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

crmNotificationSchema.index({ createdAt: -1 });
crmNotificationSchema.index({ entityType: 1, createdAt: -1 });

export default mongoose.models.CrmNotification ||
  mongoose.model("CrmNotification", crmNotificationSchema);
