import express from "express"
import BlogOperations from "../controllers/blog.js";


const router = express.Router()

router.get("/blog-status", (req,res)=>{
    res.json({message:"blog status v1 active"})
})
router.get("/all-blogs" , BlogOperations.getBlogs)
router.get("/blog/:id" , BlogOperations.getBlogById)
router.post("/blog-add")
router.post("/blog-update/:id")
router.get("/delete/blog/:id")



export default router