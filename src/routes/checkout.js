import express from "express";
import userAuth from "../middleware/user.js";
import { quote, createCodOrder } from "../controllers/checkout.js";
const router = express.Router();
router.post("/quote", userAuth.isLoggedIn, quote);
router.post("/orders/cod", userAuth.isLoggedIn, createCodOrder);
export default router;
