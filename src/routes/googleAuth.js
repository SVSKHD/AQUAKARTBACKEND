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
// No auth middleware: sign-out works even with an expired token.
router.post("/auth/logout", (req, res) =>
  googleAuthController.logout(req, res),
);

export default router;
