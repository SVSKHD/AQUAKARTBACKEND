import express from "express"
import userAuth from "../../middleware/user";
import stockOperations from "../../controllers/crm/stock";

const router = express.Router();

router.get("/stock-status", (req, res) => {
    res.json({ message: "Stock Status v1 active" });
});

router.get("/all-stock", userAuth.checkAdmin, stockOperations.getAllStock);
router.post("/add-stock", userAuth.checkAdmin, stockOperations.createStock);
router.put("/update-stock/:id", userAuth.checkAdmin, stockOperations.updateStock);
router.delete("/delete-stock/:id", userAuth.checkAdmin, stockOperations.deleteStock);


export default router;