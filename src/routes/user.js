import express from "express";
import userController from "../controllers/user.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/user-status", (req, res) => {
  res.json({ status: "User Status V1 Active" });
});

router.post("/login", userController.userLogin);
router.post("/phone/login", userController.userPhoneLogin);
router.post("/verify/phone/otp", userController.verifyPhoneLogin);
router.post("/email/login", userController.userEmailOtpLogin);
router.post("/verify/email/otp", userController.verifyEmailLogin);
router.post("/signup", userController.userRegister);
router.post("/forget-password", userController.userForgetPassword);
router.post(
  "/user/update-details/:id",
  userAuth.isLoggedIn,
  userController.updateDetails
);
router.post("/check-login", userAuth.isLoggedIn, userController.checkLogin);

export default router;
