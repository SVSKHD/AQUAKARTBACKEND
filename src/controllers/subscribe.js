import AquaEmailSubscription from "../models/subscribe.js";
import subscriptionEmail from "../utils/emailTemplates/subscribeEmail.js";
import sendEmail from "../notifications/email/send-email.js";

// Subscribe to email
const subscribe = async (req, res) => {
  try {
    const { email } = req.body;

    // Check if the email already exists
    const existingSubscription = await AquaEmailSubscription.findOne({ email });
    if (existingSubscription) {
      return res.status(400).json({ message: "Email already subscribed" });
    }

    // Create a new subscription
    const newSubscription = new AquaEmailSubscription({ email });
    await newSubscription.save();

    const content = subscriptionEmail(newSubscription.email);
    await sendEmail({
      email: newSubscription.email,
      subject: "Email Subscription",
      message: message,
      content: content,
    });

    return res
      .status(201)
      .json({ message: "Subscription successful", data: newSubscription });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

// Unsubscribe email by email
const unsubscribe = async (req, res) => {
  try {
    const { email } = req.body;

    // Find and delete the subscription
    const subscription = await AquaEmailSubscription.findOneAndDelete({
      email,
    });
    if (!subscription) {
      return res.status(404).json({ message: "Email not found" });
    }

    return res
      .status(200)
      .json({ message: "Unsubscription successful", data: subscription });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

// Get all subscriptions
const getAllSubscriptions = async (req, res) => {
  try {
    const subscriptions = await AquaEmailSubscription.find();
    return res.status(200).json({ data: subscriptions });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

// Delete a specific subscription by email
const deleteSubscriptionByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    // Find and delete the subscription by email
    const subscription = await AquaEmailSubscription.findOneAndDelete({
      email,
    });
    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    return res
      .status(200)
      .json({ message: "Subscription deleted", data: subscription });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

// Delete a specific subscription by ID
const deleteSubscriptionById = async (req, res) => {
  try {
    const { id } = req.params;

    // Find and delete the subscription by ID
    const subscription = await AquaEmailSubscription.findByIdAndDelete(id);
    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    return res
      .status(200)
      .json({ message: "Subscription deleted", data: subscription });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const EmailOperations = {
  subscribe,
  unsubscribe,
  getAllSubscriptions,
  deleteSubscriptionByEmail,
  deleteSubscriptionById,
};

export default EmailOperations;
