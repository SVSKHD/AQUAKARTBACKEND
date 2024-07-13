import express from "express"
import OrderOperations from "../controllers/order.js"
const router = express.Router()

//cod order
router.post("/order/cod",OrderOperations.createCodOrder)
router.get("/order/:id",OrderOperations.getOrdersById)
router.get("/orders/user/:id", OrderOperations.getOrdersByUserId)


export default router