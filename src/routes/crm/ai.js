import express from "express";
import AIOperations from "../../controllers/ai.js";
import AIInvoice from "../../controllers/crm/aiInvoice.js";
import AIChats from "../../controllers/crm/aiChats.js";
import AIUsers from "../../controllers/crm/aiUsers.js";
import {
  authenticateStaff,
  staffHasPermission,
} from "../../middleware/permissions.js";

const router = express.Router();

// CRM AI has no usage limits (staff only).
const canManageInvoices = (req, res, next) =>
  staffHasPermission(req.user, "invoices.manage")
    ? next()
    : res.status(403).json({
        success: false,
        message: "Insufficient permission",
        required: ["invoices.manage"],
      });

router.use(authenticateStaff);

router.get("/status", AIOperations.status);
router.post("/generate", AIOperations.crmGenerate);
router.post("/generate/stream", AIOperations.crmGenerateStream);
router.get("/chats", AIChats.list);
router.post("/chats", AIChats.create);
router.get("/chats/:id", AIChats.get);
router.patch("/chats/:id", AIChats.update);
router.delete("/chats/:id", AIChats.remove);

// Customer transcripts are a separate, privileged editorial workflow.
export const canReviewCustomerChats = (req, res, next) =>
  ["customers.read", "ai.chats.read"].every((permission) =>
    staffHasPermission(req.user, permission),
  )
    ? next()
    : res.status(403).json({
        success: false,
        message: "Insufficient permission",
        required: ["customers.read", "ai.chats.read"],
      });
export const canDraftCustomerBlogs = (req, res, next) =>
  staffHasPermission(req.user, "blogs.manage")
    ? next()
    : res.status(403).json({
        success: false,
        message: "Insufficient permission",
        required: ["blogs.manage"],
      });

router.get("/users", canReviewCustomerChats, AIUsers.list);
router.get("/users/:userId", canReviewCustomerChats, AIUsers.get);
router.get("/users/:userId/chats", canReviewCustomerChats, AIUsers.chats);
router.get(
  "/users/:userId/chats/:chatId",
  canReviewCustomerChats,
  AIUsers.chat,
);
router.get(
  "/users/:userId/chats/:chatId/blog-drafts",
  canReviewCustomerChats,
  canDraftCustomerBlogs,
  AIUsers.drafts,
);
router.post(
  "/users/:userId/chats/:chatId/blog-drafts",
  canReviewCustomerChats,
  canDraftCustomerBlogs,
  AIUsers.createDraft,
);

// AI invoice assistant
const invoice = express.Router();
invoice.use(canManageInvoices);
invoice.get("/products", AIInvoice.searchProducts);
invoice.get("/sessions", AIInvoice.listSessions);
invoice.post("/sessions", AIInvoice.createSession);
invoice.get("/sessions/:id", AIInvoice.getSession);
invoice.post("/sessions/:id/messages", AIInvoice.sendMessage);
invoice.patch("/sessions/:id/draft", AIInvoice.updateDraft);
invoice.post("/sessions/:id/create", AIInvoice.createInvoice);
invoice.post("/sessions/:id/email", AIInvoice.emailInvoice);
invoice.delete("/sessions/:id", AIInvoice.cancelSession);
router.use("/invoice", invoice);

export default router;
