import express from "express";

const router = express.Router()

router.get("/user-status",(req,res)=>{
    res.json({"status":"User Status V1 Active"})
})


export default router



