import AquaProduct from "../models/product.js"
import cloudinary from "cloudinary"

const addProduct = async(req,res)=>{

}
const getProducts = async(req,res)=>{
    try {
        const products = await AquaProduct.find({})
        return res.status(200).json({status:true, data:products})
    } catch (error) {
        console.error('Error getting subcategories:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
const getProduct = async (req, res) => {
    const { id } = req.params;
    try {
      const product = await AquaProduct.findById(id).populate('category');
      if (!product) {
        return res.status(404).json({ success: false, message: 'product not found' });
      }
      return res.status(200).json({ success: true, data: product });
    } catch (error) {
      console.error('Error getting product:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  };
const ProductOperations = {
getProducts,
getProduct
}
export default ProductOperations