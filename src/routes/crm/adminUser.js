import express from "express"
import AquaAdminUserOperations from "../../controllers/crm/adminUser.js"


const router = express.Router()

router.get("/status", (req,res)=>{
    res.json({"message":"Admin user v1 Status is Active"})
})

router.post("/signup",AquaAdminUserOperations.signup)
router.post("/login", AquaAdminUserOperations.login)
router.post("/create-user",userAuth.checkAdmin)


export default router