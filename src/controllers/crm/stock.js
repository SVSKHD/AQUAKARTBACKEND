import mongoose from "mongoose";
import AquaStock from "../../models/crm/stock.js";


const getAllStock = async (req, res) => {
    try{
      const stock = await AquaStock.find({})
        res.status(200).json({ success: true, data: stock });
    }catch(error){
        res.status(500).json({ error: "Internal Server Error" });
    }
}

const createStock = async (req, res) => {
    try{
        const { productId, quantity, distributorPrice } = req.body;

        const total = quantity * distributorPrice;
        const newStock = new AquaStock({
            productId,
            quantity,
            distributorPrice,
            totalValue: total,
        });

        const savedStock = await newStock.save();
        res.status(201).json({ success: true, data: savedStock });
    }catch(error){
        res.status(500).json({ error: "Internal Server Error" });
    }
}

const updateStock = async (req, res) => {
    const { id } = req.params;
    try{
        const updatedStock = await AquaStock.findByIdAndUpdate(id, req.body, { new: true });
        if(!updatedStock){
            return res.status(404).json({ success: false, message: "Stock record not found" });
        }
        res.status(200).json({ success: true, data: updatedStock });
    }catch(error){
        res.status(500).json({ error: "Internal Server Error" });
    }
}

const deleteStock = async (req, res) => {
    const { id } = req.params;
    try{
        const deletedStock = await AquaStock.findByIdAndDelete(id);
        if(!deletedStock){
            return res.status(404).json({ success: false, message: "Stock record not found" });
        }
        res.status(200).json({ success: true, data: deletedStock });
    }catch(error){
        res.status(500).json({ error: "Internal Server Error" });
    }
}

const stockOperations= {
    getAllStock,
    createStock,
    updateStock,
    deleteStock,
};
export default stockOperations;