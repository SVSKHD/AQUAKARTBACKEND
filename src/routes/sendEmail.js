import express from "express"
import SendEmail from "../controllers/sendEmail.js"

const router = express.Router()

router.post("/send-email",SendEmail)



export default router