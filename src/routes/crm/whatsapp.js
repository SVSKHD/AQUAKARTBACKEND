import express from "express";
import userAuth from "../../middleware/user.js";
import WhatsAppCrm from "../../controllers/crm/whatsapp.js";

const router = express.Router();

router.get("/status", userAuth.checkAdmin, (_req, res) => {
  res.json({ success: true, message: "CRM WhatsApp inbox is active" });
});

router.get("/conversations", userAuth.checkAdmin, WhatsAppCrm.listConversations);
router.get(
  "/conversations/:id",
  userAuth.checkAdmin,
  WhatsAppCrm.getConversation,
);
router.get(
  "/conversations/:id/messages",
  userAuth.checkAdmin,
  WhatsAppCrm.getMessages,
);
router.patch(
  "/conversations/:id",
  userAuth.checkAdmin,
  WhatsAppCrm.updateConversation,
);
router.post(
  "/conversations/:id/send-template",
  userAuth.checkAdmin,
  WhatsAppCrm.sendTemplateReply,
);

export default router;
