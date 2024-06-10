import express from 'express'
import categoryFunctions from '../controllers/category'

const router = express.Router()

router.get("/allcategories" , categoryFunctions().getAllCategories)
router.get("/category/:id" , categoryFunctions().getCategory)
router.get("/category-remove/:id" , categoryFunctions().deleteCategory)
router.post("/category-add" , ,categoryFunctions().addCategory)
router.put("/category-update" , ,categoryFunctions().updateCategory)
export default router