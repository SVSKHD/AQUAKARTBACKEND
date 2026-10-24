import mongoose from "mongoose";

const RETENTION_DAYS = Math.max(
  1,
  Number(process.env.SCHEDULED_JOB_RUN_RETENTION_DAYS) || 90,
);

const ScheduledJobRunSchema = new mongoose.Schema(
  {
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaScheduledJob",
      required: true,
      index: true,
    },
    jobName: String,
    action: String,
    trigger: { type: String, enum: ["schedule", "manual"], required: true },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
    instance: String,
    status: {
      type: String,
      enum: ["running", "success", "failed"],
      default: "running",
      index: true,
    },
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    durationMs: Number,
    result: mongoose.Schema.Types.Mixed,
    error: String,
  },
  { timestamps: true },
);

ScheduledJobRunSchema.index({ job: 1, startedAt: -1 });
ScheduledJobRunSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 },
);

export default mongoose.models.AquaScheduledJobRun ||
  mongoose.model("AquaScheduledJobRun", ScheduledJobRunSchema);
