import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const addressSchema = new mongoose.Schema({
  street: String,
  city: String,
  state: String,
  postalCode: String,
});

const UserSchema = new mongoose.Schema(
  {
    id: { type: String },
    firebaseUid: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    authProvider: {
      type: String,
      enum: ["google.com"],
    },
    photoURL: { type: String, trim: true },
    firstLoginAt: { type: Date },
    lastLoginAt: { type: Date },
    loginCount: { type: Number, default: 0 },
    resetPasswordOtp: { type: Number },
    resetPasswordDate: { type: Date },
    confirmationOtp: { type: Number },
    confirmationOtpDate: { type: Date },
    mobileOtp: { type: Number },
    ismobileLoginConfirmation: { type: Boolean },
    isMobileConfirmationDate: { type: Date },
    isGoogleLogin: { type: Boolean },
    isFaceBookLogin: { type: Boolean },
    isTwitterLogin: { type: Boolean },
    googleData: { type: Object },
    facebookData: { type: Object },
    twitterData: { type: Object },
    emailOtp: { type: Number },
    isEmailVerfied: { type: Boolean },
    userSignedupDate: { type: Date, default: Date.now },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      set: (value) => {
        if (typeof value !== "string") return undefined;
        const cleaned = value.trim();
        return cleaned.length ? cleaned : undefined;
      },
    },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    password: { type: String },
    lastDetailsUpdatedDate: { type: Date },
    forgotPasswordDate: { type: Date },
    lastPasswordUpdated: { type: Date },
    dob: { type: Date },
    EmailOtp: { type: Number },
    MobileOtp: { type: Number },
    verificationOtp: { type: Number },
    profileUpdated: { type: Date },
    phone: {
      type: Number,
      unique: true,
      sparse: true,
    },
    alternativeEmail: { type: String, trim: true },
    photo: {
      id: { type: String },
      secure_url: { type: String },
    },
    gstDetails: {
      gstEmail: { type: String },
      gstNo: { type: String },
      gstPhone: { type: Number },
      gstAddres: { type: String },
    },
    cart: [
      {
        productId: mongoose.Schema.Types.ObjectId,
        quantity: Number,
      },
    ],
    orders: [
      {
        orderId: mongoose.Schema.Types.ObjectId,
        orderDate: Date,
      },
    ],
    wishes: [
      {
        productId: mongoose.Schema.Types.ObjectId,
        addedDate: Date,
      },
    ],
    role: {
      type: Number,
      default: 2,
    },
    referral: [
      {
        userId: mongoose.Schema.Types.ObjectId,
        userSignupDate: Date,
      },
    ],
    selectedAddress: addressSchema,
    addresses: [addressSchema],
  },
  { timestamps: true },
);

UserSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $exists: true, $ne: null } },
  },
);

UserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  if (!this.password) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.generateAuthToken = function () {
  return jwt.sign(
    { _id: this._id, email: this.email, role: this.role },
    process.env.JWT_SECRET,
    { expiresIn: "30d" },
  );
};

UserSchema.methods.validatePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

const AquaEcomUser =
  mongoose.models.AquaEcomUser || mongoose.model("AquaEcomUser", UserSchema);

export default AquaEcomUser;
