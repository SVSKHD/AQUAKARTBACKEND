import express from "express"
import PaymentOperations from "../../controllers/crm/paymentLink.js"
import paymentOperations from "../../controllers/phonepeGateway.js"


const router = express.Router()
router.get("/status", (req,res)=>{
    res.json({"message":"Aquakart v1 status is active"})
})

router.post("/phonepe/payment-link",paymentOperations.payPhonepe)




export default router