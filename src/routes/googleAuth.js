import express from "express";
import googleAuthController from "../controllers/googleAuth.js";
import verifyFirebaseToken from "../middleware/firebaseAuth.js";

const router = express.Router();

router.post("/auth/google", verifyFirebaseToken, googleAuthController.googleLogin);

export default router;
