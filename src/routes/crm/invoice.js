import express from "express";

const router = express.Router();

router.get("invoice-status", async (req, res) => {
  res.json({ message: "Invoice Status v1 active" });
});

export default router;
