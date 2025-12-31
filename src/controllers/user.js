import AquaEcomUser from "../models/user.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import sendEmail from "../notifications/email/send-email.js";
import signupEmail from "../notifications/email/signupTemplate.js";
import signupOtpTemplate from "../notifications/email/signupOtp.js";
import forgotPassword from "../notifications/email/forgotPassword.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import userLoginNotificationTemplateToAdmin from "../notifications/email/adminInfo/NewUserLogin.js";
import axios from "axios";

// User Login
const userLogin = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await AquaEcomUser.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const isMatch = await user.validatePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const token = user.generateAuthToken();
    const userDetails = await AquaEcomUser.findById(user._id).select(
      "-password",
    );
    res.json({ token, user: userDetails });
  } catch (error) {
    console.error("Error during user login:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const userEmailOtpLogin = async (req, res) => {
  const { email } = req.body;

  function generateRandomSixDigitNumber() {
    const randomNumber = Math.floor(100000 + Math.random() * 900000);
    return randomNumber;
  }

  try {
    const sixDigitNumber = generateRandomSixDigitNumber();
    let userExist = false;

    const name = email.split("@")[0];

    let user = await AquaEcomUser.findOne({ email });

    let subject, message, content;
    if (user) {
      userExist = true;
      user.emailOtp = sixDigitNumber;
      subject = "Your Login OTP for AquaKart";
      message = `Welcome back to AquaKart, ${name}! Your Login OTP is: ${sixDigitNumber}. Enjoy your shopping experience with us!`;
      content = signupOtpTemplate(email, name, sixDigitNumber);
    } else {
      userExist = false;
      user = new AquaEcomUser({ email, emailOtp: sixDigitNumber });
      subject = "Your Signup OTP for AquaKart";
      message = `Welcome to AquaKart, ${name}! Your Signup OTP is: ${sixDigitNumber}. Enjoy your shopping experience with us!`;
      content = signupOtpTemplate(email, name, sixDigitNumber);
    }

    const emailResult = await sendEmail({
      email: user.email,
      subject,
      message,
      content,
    });

    if (emailResult.success) {
      await user.save();
      return res.status(200).json({
        success: true,
        emailMessage: emailResult.message,
        userExist,
      });
    } else {
      // 🔥 IMPORTANT: expose the internal error for now
      return res.status(400).json({
        success: false,
        message: "Failed to send OTP",
        emailMessage: emailResult.message,
        error: emailResult.error || null,
        code: emailResult.code || null,
      });
    }
  } catch (error) {
    console.error("Error during email OTP login:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
const userPhoneLogin = async (req, res) => {
  const { phone } = req.body;

  const generateOtp = () => Math.floor(100000 + Math.random() * 900000);

  // sanitize and keep as string
  const sanitizedPhone = String(phone ?? "").replace(/\D/g, "");
  if (!sanitizedPhone) {
    return res
      .status(400)
      .json({ success: false, message: "Phone number is required" });
  }

  // optional: prepend country code if your WA provider expects it
  const whatsappPhone = sanitizedPhone.startsWith("91")
    ? `+${sanitizedPhone}`
    : `+91${sanitizedPhone}`; // adjust to your rules/provider

  const otp = generateOtp();

  try {
    // Send OTP first (so we don't persist if provider fails)
    const messageNew = `Welcome to Aquakart! Your Signup OTP is: ${otp}. Enjoy your shopping experience with us!`;
    const messageExisting = `Welcome back to Aquakart! Your Login OTP is: ${otp}. Enjoy your shopping experience with us!`;

    // Check existence
    const existing = await AquaEcomUser.findOne({
      phone: sanitizedPhone,
    }).lean();
    const userExist = Boolean(existing);

    const otpData = await axios.post(
      `${process.env.WHATSAPPAPI}/api/send/text`,
      {
        accessToken: process.env.WHATSAPPAPIKEY,
        mobile: `91${sanitizedPhone}`,
        text: userExist ? messageExisting : messageNew,
      },
    );

    if (!otpData?.data.success) {
      return res.status(400).json({
        success: false,
        message: "Failed to send OTP",
        otpMessage: otpData?.message || "Provider error",
      });
    }

    // Atomic upsert: set mobileOtp always; set email only on insert
    // Use a stable placeholder email (NOT dependent on OTP)
    const placeholderEmail = `${sanitizedPhone}@aquakart.co.in`;

    await AquaEcomUser.findOneAndUpdate(
      { phone: sanitizedPhone },
      {
        $set: { mobileOtp: otp },
        $setOnInsert: { phone: sanitizedPhone, email: placeholderEmail },
      },
      { new: true, upsert: true },
    );

    return res.status(200).json({
      success: true,
      otpMessage: otpData.message,
      userExist,
    });
  } catch (error) {
    if (error?.code === 11000) {
      try {
        await AquaEcomUser.updateOne(
          { phone: sanitizedPhone },
          { $set: { mobileOtp: otp } },
        );
        return res.status(200).json({
          success: true,
          otpMessage: "OTP sent successfully",
          userExist: true,
        });
      } catch (updateError) {
        return res
          .status(500)
          .json({ success: false, message: updateError.message });
      }
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

const verifyPhoneLogin = async (req, res) => {
  const { phone, otp } = req.body;

  try {
    // Find the user by phone number
    const user = await AquaEcomUser.findOne({ phone });

    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "User not found" });
    }

    // Check if the provided OTP matches the stored OTP
    if (user.mobileOtp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Generate the auth token
    const token = user.generateAuthToken();

    // Fetch user details excluding the password
    const userDetails = await AquaEcomUser.findById(user._id).select(
      "-password",
    );

    // Send the response
    res.status(200).json({ success: true, token, user: userDetails });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const verifyEmailLogin = async (req, res) => {
  const { email, otp } = req.body;

  try {
    // Find the user by phone number
    const user = await AquaEcomUser.findOne({ email });

    if (!user) {
      return res
        .status(400)
        .json({ success: false, message: "User not found" });
    }

    // Check if the provided OTP matches the stored OTP
    if (user.emailOtp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Generate the auth token
    const token = user.generateAuthToken();

    // Fetch user details excluding the password
    const userDetails = await AquaEcomUser.findById(user._id).select(
      "-password",
    );

    if (userDetails) {
      const date = new Date();
      const adminEmail = process.env.SMTPEMAIL;
      const adminMessage = userLoginNotificationTemplateToAdmin(
        userDetails.email,
        userDetails.firstName,
        date,
      );
      const adminEmailResult = await sendEmail({
        email: adminEmail,
        subject: "New User Login Alert",
        message: "A new user has logged into AquaKart",
        content: adminMessage,
      });
    }

    // Send the response
    res.status(200).json({ success: true, token, user: userDetails });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// User Registration
const userRegister = async (req, res) => {
  const { email, password, firstName, lastName, phone } = req.body;

  try {
    const existingUser = await AquaEcomUser.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const newUser = new AquaEcomUser({
      email,
      password,
      firstName,
      lastName,
      phone,
    });

    await newUser.save();
    const token = newUser.generateAuthToken();
    const userDetails = await AquaEcomUser.findById(newUser._id).select(
      "-password",
    );
    const emailContent = signupEmail(userDetails.email); // This function should return the HTML content of the email
    const emailResult = await sendEmail({
      email: userDetails.email,
      subject: "Welcome to AquaKart!",
      message: "Thanks for signing up with us!",
      content: emailContent,
    });
    res.status(201).json({ token, user: userDetails });
  } catch (error) {
    console.error("Error during user registration:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// User Forgot Password
const userForgetPassword = async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const user = await AquaEcomUser.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.forgotPasswordDate = new Date();

    await user.save();
    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error during password reset:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Update User Details
const updateDetails = async (req, res) => {
  const id = req.params.id;
  const { newDetails } = req.body;

  try {
    const user = await AquaEcomUser.findById(id);

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    const updatedUser = await AquaEcomUser.findByIdAndUpdate(
      id,
      { $set: newDetails },
      { new: true },
    );

    return res.status(200).json(updatedUser);
  } catch (error) {
    console.error("Error during updating user details:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
const updateIdentifierDetails = async (req, res) => {
  const { identifier, newDetails } = req.body;

  try {
    // Define the search criteria based on the identifier type
    const searchCriteria = identifier.includes("@")
      ? { email: identifier }
      : { phone: identifier };

    // Check if the new phone number or email already exists for another user
    if (newDetails.phone) {
      const phoneExists = await AquaEcomUser.findOne({
        phone: newDetails.phone,
      });
      if (phoneExists && phoneExists._id.toString() !== req.user._id) {
        return res.status(400).json({ message: "Phone number already in use" });
      }
    }

    if (newDetails.email) {
      const emailExists = await AquaEcomUser.findOne({
        email: newDetails.email,
      });
      if (emailExists && emailExists._id.toString() !== req.user._id) {
        return res.status(400).json({ message: "Email already in use" });
      }
    }

    const user = await AquaEcomUser.findOneAndUpdate(
      searchCriteria,
      { $set: newDetails },
      { new: true },
    );

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error("Error during updating user details:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Check Login
const checkLogin = async (req, res) => {
  try {
    const token = req.header("Authorization").replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await AquaEcomUser.findById(decoded._id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ message: "User logged in", user });
  } catch (error) {
    console.error("Error during token validation:", error);
    res.status(401).json({ message: "Token is not valid" });
  }
};

const userController = {
  userLogin,
  userEmailOtpLogin,
  userPhoneLogin,
  verifyPhoneLogin,
  verifyEmailLogin,
  userRegister,
  userForgetPassword,
  updateDetails,
  updateIdentifierDetails,
  checkLogin,
};

export default userController;
