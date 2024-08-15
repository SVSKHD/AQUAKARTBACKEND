import express from "express";
import EmailOperations from "../controllers/subscribe.js";

const router = express.Router();

router.post("/create-subscritption", EmailOperations.subscribe);
router.post("/delete-subscription", EmailOperations.unsubscribe);

export default router;
