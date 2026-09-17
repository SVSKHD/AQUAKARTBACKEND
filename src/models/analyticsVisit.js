import mongoose from "mongoose";

const analyticsVisitSchema = new mongoose.Schema(
  {
    visitId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    pagePath: { type: String, required: true, index: true },
    pageTitle: { type: String, default: "" },
    referrer: { type: String, default: "" },
    startedAt: { type: Date, default: Date.now, index: true },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },
  },
  { timestamps: true },
);

analyticsVisitSchema.index({ sessionId: 1, startedAt: -1 });
analyticsVisitSchema.index({ pagePath: 1, startedAt: -1 });

export default mongoose.model("AquaAnalyticsVisit", analyticsVisitSchema);
