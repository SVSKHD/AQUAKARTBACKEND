import express from "express";
import AquaAdminUserOperations from "../../controllers/crm/adminUser.js";
import userAuth from "../../middleware/user.js";

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({ message: "Admin user v1 Status is Active" });
});

router.post("/signup", AquaAdminUserOperations.signup);
router.post("/login", AquaAdminUserOperations.login);
// Kept for old CRM clients; new clients use POST /v1/admin/staff.
router.post("/create-user", userAuth.checkAdmin, (_req, res) =>
  res.status(410).json({
    success: false,
    message: "Use POST /v1/admin/staff",
  }),
);

// get all ecom users
router.get(
  "/get-all-users",
  userAuth.checkAdmin,
  AquaAdminUserOperations.getAllEcomUsers,
);

export default router;
