import mongoose from "mongoose";

// Runtime configuration managed from the CRM (collection "aqua-env"). Every
// value is stored encrypted (AES-256-GCM, see src/services/aquaEnv.js); only
// DB_URL and AQUA_ENV_ENCRYPTION_KEY stay in the server's environment.
const EncryptedValueSchema = new mongoose.Schema(
  {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    data: { type: String, required: true },
  },
  { _id: false },
);

const AquaEnvSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: /^[A-Z][A-Z0-9_]{0,99}$/,
    },
    value: { type: EncryptedValueSchema, required: true },
    // Secret values are masked in every CRM response; plain ones are shown.
    secret: { type: Boolean, default: true },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AquaAdminUser" },
  },
  { timestamps: true, collection: "aqua-env" },
);

export default mongoose.models.AquaEnv ||
  mongoose.model("AquaEnv", AquaEnvSchema);
