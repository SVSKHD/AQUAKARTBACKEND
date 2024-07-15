import express from "express"
import OrderOperations from "../controllers/order.js"
import paymentOperations from "../controllers/phonepeGateway.js"
const router = express.Router()

//cod order
router.post("/order/cod",OrderOperations.createCodOrder)
router.post("/order/pay", paymentOperations.payPhonepe)
router.post("order/paycheck/:id",paymentOperations.handlePhonePeOrder)
router.get("/order/:id",OrderOperations.getOrdersById)
router.get("/orders/user/:id", OrderOperations.getOrdersByUserId)



export default router