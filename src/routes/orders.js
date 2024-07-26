import express from "express"
import OrderOperations from "../controllers/order.js"
import userAuth from "../middleware/user.js"
import paymentOperations from "../controllers/phonepeGateway.js"
const router = express.Router()

//cod order
router.post("/order/cod",OrderOperations.createCodOrder)
router.post("/order/pay", paymentOperations.payPhonepe)
router.post("order/paycheck/:id",paymentOperations.handlePhonePeOrder)
router.get("/order/:id",OrderOperations.getOrdersById)
router.get("/orders/user/:id",userAuth.isLoggedIn ,OrderOperations.getOrdersByUserId)
router.get("/order/transaction-id/:id",userAuth.isLoggedIn, OrderOperations.getOrderByTransactionId)


export default router