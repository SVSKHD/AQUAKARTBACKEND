import express from "express";
import AIOperations from "../controllers/ai.js";
import optionalUserAuth from "../middleware/optionalUser.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

// Daily question allowance (guests 3 per IP, logged-in customers 5 per
// account, reset at midnight IST) is enforced in the controller via
// services/aiQuota.js, so validation errors and AI failures don't count.
router.get("/status", AIOperations.status);
router.get("/quota", optionalUserAuth, AIOperations.quota);
// After a guest logs in mid-chat: count today's guest questions toward the account.
router.post("/quota/carry-guest", userAuth.isLoggedIn, AIOperations.carryQuota);
router.post("/chat", optionalUserAuth, AIOperations.ecomChat);
router.post("/chat/stream", optionalUserAuth, AIOperations.ecomChatStream);

// Saved conversations (logged-in customers only).
router.get("/chat/history", userAuth.isLoggedIn, AIOperations.listChatHistory);
router.delete(
  "/chat/history",
  userAuth.isLoggedIn,
  AIOperations.clearChatHistory,
);
router.get(
  "/chat/history/:id",
  userAuth.isLoggedIn,
  AIOperations.getChatSession,
);
// Rename / pin: { title?, pinned? }
router.patch(
  "/chat/history/:id",
  userAuth.isLoggedIn,
  AIOperations.updateChatSession,
);
router.delete(
  "/chat/history/:id",
  userAuth.isLoggedIn,
  AIOperations.deleteChatSession,
);

export default router;
