import express from 'express';
import SoftenerHydOperations from '../controllers/softenersHyd.js';
import userAuth from "../middleware/user.js";
import multer from "multer";

const router = express.Router();
const storage = multer.memoryStorage(); // Use memory storage or disk storage based on your requirement
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});
router.get("/softeners-hyd", (req, res) => {
  res.status(200).json({ message: "Softeners Hyd route is working" });
});

router.post("/softeners-hyderabad",userAuth.checkAdmin,   upload.fields([
    { name: "photos", maxCount: 10 }
  ])  ,SoftenerHydOperations.createSoftenersHyd);
router.get("/softeners-hyderabad", SoftenerHydOperations.getSoftenersHyd);


export default router;