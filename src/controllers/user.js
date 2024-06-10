import AquaEcomUser from "../models/user.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

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
    const userDetails = await AquaEcomUser.findById(user._id).select("-password");
    res.json({ token, user: userDetails });
  } catch (error) {
    console.error("Error during user login:", error);
    res.status(500).json({ message: "Server error" });
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
    const userDetails = await AquaEcomUser.findById(newUser._id).select("-password");
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
      { new: true }
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
  userRegister,
  userForgetPassword,
  updateDetails,
  checkLogin,
};

export default userController;
