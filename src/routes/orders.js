import express from "express"
import OrderOperations from "../controllers/order.js"
const router = express.Router()

//cod order
router.post("/order/cod",OrderOperations.createCodOrder)


export default router