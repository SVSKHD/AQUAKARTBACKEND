import mongoose from "mongoose";

const ACTIVITY_TYPES = ["task", "call", "email", "meeting", "note"];
const ACTIVITY_STATUSES = ["pending", "completed"];
const ACTIVITY_RELATIONS = ["lead", "customer", "deal"];

const activitySchema = new mongoose.Schema(
  {
    related_to: {
      type: String,
      enum: ACTIVITY_RELATIONS,
      required: [true, "Related type is required"],
      index: true,
    },
    related_id: {
      type: String,
      required: [true, "Related id is required"],
      trim: true,
      index: true,
    },
    type: {
      type: String,
      enum: ACTIVITY_TYPES,
      default: "task",
      index: true,
    },
    title: {
      type: String,
      required: [true, "Activity title is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: ACTIVITY_STATUSES,
      default: "pending",
      index: true,
    },
    due_date: {
      type: Date,
      default: null,
      index: true,
    },
    completed_at: {
      type: Date,
      default: null,
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
      index: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AquaAdminUser",
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

activitySchema.index({ status: 1, due_date: 1 });
activitySchema.index({ related_to: 1, related_id: 1, created_at: -1 });

const AquaActivity =
  mongoose.models.AquaActivity ||
  mongoose.model("AquaActivity", activitySchema);

export { ACTIVITY_TYPES, ACTIVITY_STATUSES, ACTIVITY_RELATIONS };
export default AquaActivity;
