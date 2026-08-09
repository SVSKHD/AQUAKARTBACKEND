import express from "express";
import userAuth from "../middleware/user.js";
import { getMine, attribute } from "../controllers/referrals.js";
const router = express.Router();
router.get("/me", userAuth.isLoggedIn, getMine);
router.post("/attribute", userAuth.isLoggedIn, attribute);
export default router;
