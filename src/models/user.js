import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const addressSchema = new mongoose.Schema({
  street: String,
  city: String,
  state: String,
  postalCode: String,
});

const UserSchema = new mongoose.Schema({
  // user id unique for every one
  id: { type: String },
  // reset info and required info
  resetPasswordOtp: { type: Number },
  resetPasswordDate: { type: Date },
  confirmationOtp: { type: Number },
  confirmationOtpDate: { type: Date },
  // mobile confirmation
  mobileOtp: { type: Number },
  ismobileLoginConfirmation: { type: Boolean },
  isMobileConfirmationDate: { type: Date },
  // social credentials
  isGoogleLogin: { type: Boolean },
  isFaceBookLogin: { type: Boolean },
  isTwitterLogin: { type: Boolean },
  googleData: { type: Object },
  facebookData: { type: Object },
  twitterData: { type: Object },
  // email verifications
  emailOtp: { type: Number },
  isEmailVerfied: { type: Boolean },
  // user signedup date
  userSignedupDate: { type: Date, default: Date.now },
  // login creds info
  email: {
    type: String,
    unique: true,
    trim: true,
    index: true,
    lowercase: true,
  },
  firstName: {
    type: String,
    trim: true,
  },
  lastName: {
    type: String,
    trim: true,
  },
  password: {
    type: String,
  },
  lastDetailsUpdatedDate: {
    type: Date,
  },
  forgotPasswordDate: {
    type: Date,
  },
  lastPasswordUpdated: {
    type: Date,
  },
  EmailOtp: {
    type: Number,
  },
  MobileOtp: {
    type: Number,
  },
  phone: {
    type: Number,
    unique: true,
    sparse: true,
  },
  alternativeEmail: {
    type: String,
    trim: true,
  },
  photo: {
    id: {
      type: String,
    },
    secure_url: {
      type: String,
    },
  },
  gstDetails: {
    gstEmail: { type: String },
    gstNo: { type: String },
    gstPhone: { type: Number },
    gstAddres: { type: String },
  },

  cart: [
    {
      // Define the structure of items in the cart
      productId: mongoose.Schema.Types.ObjectId, // Reference to the product
      quantity: Number,
    },
  ],
  orders: [
    {
      orderId: mongoose.Schema.Types.ObjectId, // Reference to the order
      orderDate: Date,
    },
  ],
  wishes: [
    {
      // Define the structure of user wishes
      productId: mongoose.Schema.Types.ObjectId, // Reference to the product
      addedDate: Date,
    },
  ],
  role: {
    type: Number,
    default: 2,
  },
  selectedAddress: addressSchema,
  addresses: [addressSchema],
});

// Pre-save hook to hash password
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to generate JWT token
UserSchema.methods.generateAuthToken = function () {
  const token = jwt.sign(
    { _id: this._id, email: this.email, role: this.role },
    process.env.JWT_SECRET,
    { expiresIn: "30d" },
  );
  return token;
};

// Method to validate password
UserSchema.methods.validatePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

const AquaEcomUser =
  mongoose.models.AquaEcomUser || mongoose.model("AquaEcomUser", UserSchema);

export default AquaEcomUser;
