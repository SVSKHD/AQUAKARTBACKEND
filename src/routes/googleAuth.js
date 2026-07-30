import express from "express";
import googleAuthController from "../controllers/googleAuth.js";
import verifyFirebaseToken from "../middleware/firebaseAuth.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.post(
  "/auth/google",
  verifyFirebaseToken,
  googleAuthController.googleLogin,
);
router.get("/auth/me", userAuth.isLoggedIn, googleAuthController.me);
router.post("/auth/logout", userAuth.isLoggedIn, googleAuthController.logout);

export default router;
