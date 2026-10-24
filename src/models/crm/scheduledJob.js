import mongoose from "mongoose";

const ScheduledJobSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    // Stable identifier for built-in (system) jobs seeded at startup.
    key: { type: String, trim: true, unique: true, sparse: true },
    system: { type: Boolean, default: false },
    action: { type: String, required: true, index: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },

    scheduleType: {
      type: String,
      enum: ["cron", "interval", "once"],
      required: true,
    },
    cron: { type: String, trim: true },
    intervalMinutes: { type: Number, min: 1 },
    runAt: { type: Date },
    timezone: { type: String, default: "Asia/Kolkata" },
    timeoutSeconds: { type: Number, default: 300, min: 10, max: 3600 },

    enabled: { type: Boolean, default: true, index: true },
    nextRunAt: { type: Date, default: null, index: true },
    lastRunAt: { type: Date, default: null },
    lastStatus: {
      type: String,
      enum: ["running", "success", "failed", null],
      default: null,
    },
    lastError: { type: String, default: null },
    lastDurationMs: { type: Number, default: null },
    runCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },

    lockUntil: { type: Date, default: null },
    lockedBy: { type: String, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true },
);

ScheduledJobSchema.index({ enabled: 1, nextRunAt: 1 });

export default mongoose.models.AquaScheduledJob ||
  mongoose.model("AquaScheduledJob", ScheduledJobSchema);
