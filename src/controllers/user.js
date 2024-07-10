import AquaEcomUser from "../models/user.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import sendEmail from "../notifications/email/send-email.js";
import signupEmail from "../notifications/email/signupTemplate.js";
import signupOtpTemplate from "../notifications/email/signupOtp.js"
import forgotPassword from "../notifications/email/forgotPassword.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";

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

    // Extract the name from the email
    const name = email.split('@')[0];

    // Check if the user already exists
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

    // Send the OTP email
    const emailResult = await sendEmail({
      email: user.email,
      subject: subject,
      message: message,
      content: content,
    });

    if (emailResult.success) {
      // Save the user with the OTP
      await user.save();
      res.status(200).json({ success: true, emailMessage: emailResult.message, userExist: userExist });
    } else {
      res.status(400).json({ success: false, message: "Failed to send OTP", emailMessage: emailResult.message });
    }
  } catch (error) {
    console.error("Error during email OTP login:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


const userPhoneLogin = async (req, res) => {
  const { phone } = req.body;

  function generateRandomSixDigitNumber() {
    const randomNumber = Math.floor(100000 + Math.random() * 900000);
    return randomNumber;
  }

  try {
    const sixDigitNumber = generateRandomSixDigitNumber();
    let userExist = ''
    // Check if the user already exists
    let user = await AquaEcomUser.findOne({ phone });

    let message;
    if (user) {
      userExist=true
      user.mobileOtp = sixDigitNumber;
      message = `Welcome back to Aquakart! Your Login OTP is: ${sixDigitNumber}. Enjoy your shopping experience with us!`;
    } else {
      userExist=false
      user = new AquaEcomUser({ phone, mobileOtp: sixDigitNumber });
      message = `Welcome to Aquakart! Your Signup OTP is: ${sixDigitNumber}. Enjoy your shopping experience with us!`;
    }

    // Send the OTP message
    const otpData = await sendWhatsAppMessage(phone, message);


    if (otpData.success) {
      // Save the user with the OTP
      await user.save();
      res.status(200).json({ success: true, otpMessage: otpData.message, userExist:userExist });
    } else {
      res.status(400).json({ success: false, message: "Failed to send OTP", otpMessage: otpData.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const verifyPhoneLogin = async (req, res) => {
  const { phone, otp } = req.body;

  try {
    // Find the user by phone number
    const user = await AquaEcomUser.findOne({ phone });

    if (!user) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    // Check if the provided OTP matches the stored OTP
    if (user.mobileOtp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Generate the auth token
    const token = user.generateAuthToken();

    // Fetch user details excluding the password
    const userDetails = await AquaEcomUser.findById(user._id).select("-password");

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
    const user = await AquaEcomUser.findOne({ phone });

    if (!user) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    // Check if the provided OTP matches the stored OTP
    if (user.emailOtp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Generate the auth token
    const token = user.generateAuthToken();

    // Fetch user details excluding the password
    const userDetails = await AquaEcomUser.findById(user._id).select("-password");

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
  const { email, newDetails } = req.body;

  try {
    const user = await AquaEcomUser.findOneAndUpdate(
      { email },
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
  checkLogin,
};

export default userController;
