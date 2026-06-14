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

const syncProductStock = async ({ productId, quantity, distributorPrice }) => {
  if (!isValidObjectId(productId)) return null;

  const update = {
    stock: numberOrZero(quantity),
  };

  if (distributorPrice !== undefined && distributorPrice !== null) {
    update.dpPrice = numberOrZero(distributorPrice);
  }

  return AquaProduct.findByIdAndUpdate(productId, { $set: update }, { new: true });
};

const getAllStock = async (req, res) => {
  try {
    const [stockRecords, products] = await Promise.all([
      AquaStock.find({}).lean(),
      AquaProduct.find({}).select("_id title slug code stock price dpPrice").lean(),
    ]);

    const stockByProductId = new Map(
      stockRecords.map((record) => [String(record.productId), record]),
    );

    const productStocks = products.map((product) => {
      const productId = String(product._id);
      const stockRecord = stockByProductId.get(productId);
      const quantity = numberOrZero(product.stock ?? stockRecord?.quantity);
      const distributorPrice = numberOrZero(
        product.dpPrice ?? stockRecord?.distributorPrice ?? product.price,
      );

      return {
        _id: stockRecord?._id || product._id,
        id: stockRecord?._id || product._id,
        productId,
        productName: product.title,
        productSlug: product.slug,
        productCode: product.code,
        quantity,
        stock: quantity,
        distributorPrice,
        dpPrice: distributorPrice,
        price: product.price,
        totalValue: quantity * distributorPrice,
        lastUpdated: stockRecord?.lastUpdated || product.updatedAt || product.createdAt,
        source: stockRecord ? "stock" : "product",
      };
    });

    return res.status(200).json({
      success: true,
      data: productStocks,
      count: productStocks.length,
      totalQuantity: productStocks.reduce((sum, item) => sum + item.quantity, 0),
      totalValue: productStocks.reduce((sum, item) => sum + item.totalValue, 0),
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

    const product = await AquaProduct.findById(productId);
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

    const updatedProduct = await syncProductStock({
      productId,
      quantity: payload.quantity,
      distributorPrice: payload.distributorPrice,
    });

    return res.status(201).json({
      success: true,
      message: "Stock saved successfully",
      data: savedStock,
      product: updatedProduct,
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

    const product = await AquaProduct.findById(productId);
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

    const updatedProduct = await syncProductStock({
      productId,
      quantity: payload.quantity,
      distributorPrice: payload.distributorPrice,
    });

    return res.status(200).json({
      success: true,
      message: "Stock updated successfully",
      data: updatedStock,
      product: updatedProduct,
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

    const existingStock = await resolveStockRecord(id);
    const productId = existingStock?.productId || id;

    const deletedStock = await AquaStock.findOneAndDelete({
      $or: [{ _id: id }, { productId: id }],
    });

    const updatedProduct = await syncProductStock({
      productId,
      quantity: 0,
    });

    if (!deletedStock && !updatedProduct) {
      return res.status(404).json({
        success: false,
        message: "Stock record or product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Stock deleted successfully",
      data: deletedStock,
      product: updatedProduct,
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
