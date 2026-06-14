import mongoose from "mongoose";
import AquaStock from "../../models/crm/stock.js";
import AquaProduct from "../../models/product.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const numberOrZero = (value) => Number(value || 0);

const buildStockPayload = ({ productId, quantity, distributorPrice, product }) => {
  const stockQuantity = numberOrZero(quantity);
  const dpPrice = numberOrZero(distributorPrice ?? product?.dpPrice ?? product?.price);

  return {
    productId,
    productName: product?.title || product?.name || "",
    quantity: stockQuantity,
    distributorPrice: dpPrice,
    totalValue: stockQuantity * dpPrice,
    lastUpdated: new Date(),
  };
};

const resolveStockRecord = async (id) => {
  if (!isValidObjectId(id)) return null;

  return AquaStock.findOne({
    $or: [{ _id: id }, { productId: id }],
  });
};

const mapStockResponse = (stockRecord) => {
  const product = stockRecord.productId || {};
  const productId = product?._id || stockRecord.productId;
  const quantity = numberOrZero(stockRecord.quantity);
  const distributorPrice = numberOrZero(stockRecord.distributorPrice);

  return {
    _id: stockRecord._id,
    id: stockRecord._id,
    productId,
    productName: stockRecord.productName || product?.title || "Product",
    productSlug: product?.slug,
    productCode: product?.code,
    quantity,
    distributorPrice,
    dpPrice: distributorPrice,
    productPrice: product?.price,
    totalValue: quantity * distributorPrice,
    lastUpdated: stockRecord.lastUpdated || stockRecord.updatedAt || stockRecord.createdAt,
    source: "stock",
  };
};

const getAllStock = async (req, res) => {
  try {
    const stockRecords = await AquaStock.find({})
      .populate("productId", "title slug code price dpPrice")
      .sort({ updatedAt: -1 })
      .lean();

    const stocks = stockRecords.map(mapStockResponse);

    return res.status(200).json({
      success: true,
      data: stocks,
      count: stocks.length,
      totalQuantity: stocks.reduce((sum, item) => sum + item.quantity, 0),
      totalValue: stocks.reduce((sum, item) => sum + item.totalValue, 0),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock",
      error: error.message,
    });
  }
};

const createStock = async (req, res) => {
  try {
    const { productId, quantity, distributorPrice } = req.body;

    if (!isValidObjectId(productId)) {
      return res.status(400).json({
        success: false,
        message: "Valid productId is required",
      });
    }

    const product = await AquaProduct.findById(productId).select("title name price dpPrice");
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const payload = buildStockPayload({
      productId,
      quantity,
      distributorPrice,
      product,
    });

    const savedStock = await AquaStock.findOneAndUpdate(
      { productId },
      { $set: payload },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );

    return res.status(201).json({
      success: true,
      message: "Stock saved successfully",
      data: savedStock,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to save stock",
      error: error.message,
    });
  }
};

const updateStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { productId: bodyProductId, quantity, distributorPrice } = req.body;

    if (!isValidObjectId(id) && !isValidObjectId(bodyProductId)) {
      return res.status(400).json({
        success: false,
        message: "Valid stock id or productId is required",
      });
    }

    const existingStock = await resolveStockRecord(id);
    const productId = existingStock?.productId || bodyProductId || id;

    if (!isValidObjectId(productId)) {
      return res.status(400).json({
        success: false,
        message: "Valid productId is required",
      });
    }

    const product = await AquaProduct.findById(productId).select("title name price dpPrice");
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const payload = buildStockPayload({
      productId,
      quantity,
      distributorPrice,
      product,
    });

    const updatedStock = await AquaStock.findOneAndUpdate(
      { productId },
      { $set: payload },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      success: true,
      message: "Stock updated successfully",
      data: updatedStock,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update stock",
      error: error.message,
    });
  }
};

const deleteStock = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Valid stock id or productId is required",
      });
    }

    const deletedStock = await AquaStock.findOneAndDelete({
      $or: [{ _id: id }, { productId: id }],
    });

    if (!deletedStock) {
      return res.status(404).json({
        success: false,
        message: "Stock record not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Stock deleted successfully",
      data: deletedStock,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete stock",
      error: error.message,
    });
  }
};

const stockOperations = {
  getAllStock,
  createStock,
  updateStock,
  deleteStock,
};
export default stockOperations;
