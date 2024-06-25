import express from "express"
import WhatsappOperations from "../controllers/sendWhatsapp.js"
import userAuth from "../middleware/user.js"


const router = express.Router()

router.get("/status",(req,res)=>{
    res.json({message: "v1 notify is active"})
})

router.get("/send-whatsapp/:no",userAuth.checkAdmin ,WhatsappOperations.sendMessage)

export default router