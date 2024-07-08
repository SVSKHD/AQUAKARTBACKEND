import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";

const getOrdersByUserId = async (req, res) => {
  const { id } = req.params;
  try {
    const orders = await AquaOrder.find({ user: id });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res.status(400).json({ success: false, message: "No orders found" });
  }
};

const getSingleOrderIdByUserId = async (req, res) => {
  const { userId, orderId } = req.params;
  try {
    const order = await AquaOrder.findOne({ user: userId, _id: orderId });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error retrieving order" });
  }
};

const getAllOrders = async (req, res) => {
  try {
    const orders = await AquaOrder.find();
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error retrieving orders" });
  }
};

const createOrder = async (req, res) => {
  try {
    const newOrder = new AquaOrder(req.body);
    const savedOrder = await newOrder.save();
    return res.status(201).json({ success: true, data: savedOrder });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error creating order" });
  }
};

const updateOrder = async (req, res) => {
  const { id } = req.params;
  try {
    const updatedOrder = await AquaOrder.findByIdAndUpdate(id, req.body, {
      new: true,
    });
    if (!updatedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error updating order" });
  }
};

const deleteOrder = async (req, res) => {
  const { id } = req.params;
  try {
    const deletedOrder = await AquaOrder.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    return res.status(200).json({ success: true, message: "Order deleted" });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "Error deleting order" });
  }
};

const createCodOrder = async(req,res)=>{
try {
  const ordercreated = new AquaOrder(req.body)
  await ordercreated.save()
  const user = await AquaEcomUser.findById(req.body.user);
  if (!ordercreated) {
    return res
      .status(400)
      .json({ success: false, message: "Please try again" });
  }
  const message = `Welcome to Aquakart Family, We have succesfully Recieved the order `
  sendWhatsAppMessage(user.phone, message)
} catch (error) {
  res.status(500).json({
    success: false,
    message: "There is a problem in created in order, please try again later.",
    error: error.message, // It's helpful to send back a specific error message
  });
}
}

const OrderOperations = {
  getAllOrders,
  getSingleOrderIdByUserId,
  getOrdersByUserId,
  createOrder,
  updateOrder,
  deleteOrder,
  createCodOrder
};

export default OrderOperations;
