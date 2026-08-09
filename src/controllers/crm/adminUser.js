import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import AquaAdminUser from "../../models/crm/adminUser.js";
import AquaEcomUser from "../../models/user.js";

// Signup Function
const signup = async (req, res) => {
  const { email, password } = req.body;

  try {
    const existingAdminCount = await AquaAdminUser.countDocuments();
    const bootstrapKey = req.header("X-Admin-Bootstrap-Key");
    if (
      existingAdminCount > 0 &&
      (!process.env.ADMIN_BOOTSTRAP_KEY ||
        bootstrapKey !== process.env.ADMIN_BOOTSTRAP_KEY)
    ) {
      return res.status(403).json({
        message: "Public administrator signup is disabled",
      });
    }
    // Check if the user already exists
    let user = await AquaAdminUser.findOne({ email });
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Create a new user instance
    user = new AquaAdminUser({ email, password });

    // Save the user to the database
    await user.save();

    // Generate a token
    const token = user.generateAuthToken();

    // Return the user and token
    const safeUser = user.toObject();
    delete safeUser.password;
    return res.status(201).json({ token, user: safeUser });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Login Function
const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // Find the user by email
    const user = await AquaAdminUser.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Validate the password
    const isMatch = await user.validatePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Generate a token
    const token = user.generateAuthToken();

    // Return the user and token
    if (user.status === "disabled") {
      return res.status(403).json({ message: "Staff account is disabled" });
    }
    const safeUser = user.toObject();
    delete safeUser.password;
    return res.status(200).json({ token, user: safeUser });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

const getAllEcomUsers = async (req, res) => {
  try {
    const users = await AquaEcomUser.find({}).select(
      "email firstName lastName phone photoURL role status createdAt lastLoginAt loginCount",
    );
    if (!users) {
      return res.status(400).json({ success: false, data: null });
    }
    return res
      .status(200)
      .json({ success: true, data: users, totalUsers: users.length });
  } catch (error) {
    return res.status(500).json({ success: false, error });
  }
};

const getUser = async (req, res) => {};

const AquaAdminUserOperations = {
  signup,
  login,
  getAllEcomUsers,
};
export default AquaAdminUserOperations;
