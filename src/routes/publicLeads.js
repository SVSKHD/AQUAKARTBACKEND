import express from "express";
import { rateLimit } from "express-rate-limit";
import PublicLeadIntake from "../controllers/publicLeadIntake.js";

const router = express.Router();

const leadIntakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many lead submissions. Please try again shortly.",
  },
});

router.get("/status", (_req, res) => {
  res.json({ success: true, message: "Aquakart public lead intake is active" });
});

router.post(
  "/planner",
  leadIntakeLimiter,
  PublicLeadIntake.submitPlannerLead,
);
router.post(
  "/enquiry",
  leadIntakeLimiter,
  PublicLeadIntake.submitEnquiryLead,
);
router.post(
  "/product-consultation",
  leadIntakeLimiter,
  PublicLeadIntake.submitProductConsultation,
);

export default router;
