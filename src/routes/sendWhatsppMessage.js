import express from "express";
import WhatsappOperations from "../controllers/sendWhatsapp.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/status", userAuth.checkAdmin, WhatsappOperations.getStatus);
router.get(
  "/whatsapp/templates",
  userAuth.checkAdmin,
  WhatsappOperations.getTemplates,
);

router.get(
  "/send-whatsapp/:no",
  userAuth.checkAdmin,
  WhatsappOperations.sendMessage,
);
router.post(
  "/send-whatsapp",
  userAuth.checkAdmin,
  WhatsappOperations.sendWhatsAppPostMethod,
);

export default router;
