import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import sendEmail from "../notifications/email/send-email.js";
import orderEmail from "../utils/emailTemplates/orderEmail.js";
import mongoose from "mongoose";
import moment from "moment";

const ADMIN_PHONE = process.env.ADMIN_PHONE || "9014774667";

const formatCurrencyINR = (amount) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(amount);
};

const formattedDeliveryDate = (date) => {
  return moment(date).format("DD-MM-YYYY");
};

const getOrdersByUserId = async (req, res) => {
  const { id } = req.params;
  try {
    const orders = await AquaOrder.find({ user: id });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res.status(400).json({ success: false, message: "No orders found" });
  }
};

const getOrderByTransactionId = async (req, res) => {
  const { id } = req.params;
  try {
    const orders = await AquaOrder.findOne({ transactionId: id });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    return res.status(400).json({ success: false, message: "No orders found" });
  }
};

const getOrdersById = async (req, res) => {
  const { id } = req.params;
  try {
    const orders = await AquaOrder.findById(id);
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

const createCodOrder = async (req, res) => {
  try {
    const { user: userId } = req.body;
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "User id is required" });
    }

    const user = await AquaEcomUser.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const orderCreated = await new AquaOrder(req.body).save();

    const message = `Welcome to Aquakart Family, We have successfully received the order "${orderCreated.orderId}"`;
    const adminMessage = `New COD Order Received: Order ID "${orderCreated.orderId}" has been placed. Please process it accordingly.`;

    const notificationsPlanned = {
      email: Boolean(user.email),
      whatsapp: Boolean(user.phone),
      adminWhatsapp: Boolean(ADMIN_PHONE),
    };

    // Build notification jobs as lazy functions so we can send the response first
    const notificationJobs = [];

    if (user.phone) {
      notificationJobs.push(
        () =>
          sendWhatsAppMessage(user.phone, message).catch((err) =>
            console.error("Failed to send WhatsApp to user:", err),
          ),
      );
    }

    if (ADMIN_PHONE) {
      notificationJobs.push(
        () =>
          sendWhatsAppMessage(ADMIN_PHONE, adminMessage).catch((err) =>
            console.error("Failed to send WhatsApp to admin:", err),
          ),
      );
    }

    if (user.email) {
      notificationJobs.push(
        () =>
          (async () => {
            const priceInr = `${formatCurrencyINR(orderCreated.totalAmount)}/-`;
            const deliveryDate = formattedDeliveryDate(
              orderCreated.estimatedDelivery,
            );
            const content = orderEmail(
              orderCreated,
              user.email,
              priceInr,
              deliveryDate,
            );
            await sendEmail({
              email: user.email,
              subject: "Cash on Delivery Order Confirmation",
              message: "Cash on Delivery Order Confirmation - Hello Aquakart",
              content: content,
            });
          })().catch((err) =>
            console.error("Failed to send confirmation email:", err),
          ),
      );
    }

    // Fire-and-forget notifications after sending the response
    if (notificationJobs.length) {
      setImmediate(() => {
        Promise.allSettled(notificationJobs.map((job) => job())).catch((err) =>
          console.error("Notification dispatch encountered an error:", err),
        );
      });
    }

    return res.status(201).json({
      success: true,
      data: orderCreated,
      notificationsQueued: notificationJobs.length > 0,
      notificationsPlanned,
    });
  } catch (error) {
    console.error("Error creating COD order:", error);
    return res.status(500).json({
      success: false,
      message:
        "There was a problem creating the order, please try again later.",
      error: error.message,
    });
  }
};

const AdminGetOrders = async (req, res) => {
  try {
    const { id, transactionId, orderId, date, user } = req.params;

    // Construct the query object
    const query = {};
    if (id) query._id = mongoose.Types.ObjectId(id);
    if (transactionId) query.transactionId = transactionId;
    if (orderId) query.orderId = orderId;
    if (user) query.user = user;
    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      query.createdAt = {
        $gte: startDate,
        $lt: endDate,
      };
    }

    // Fetch orders based on the query
    const orders = await AquaOrder.find(query).populate("user items.productId");

    // Send the response
    res.status(200).json({ 
      count:orders?.length,
      success: true,
      data:orders 
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const updateOrderByAdmin = async (req,res)=>{
  const {id} = req.params
  const updateData = req.body
  try{
    const updatedOrder = await AquaOrder.findByIdAndUpdate(id,updateData,{new:true})
    if(!updatedOrder){
      return res.status(404).json({success:false,message:"Order not found"})
    }
    return res.status(200).json({success:true,data:updatedOrder})
  }catch(error){
    return res.status(400).json({success:false,message:"Error updating order"})
  }
}

const deleteOrderByAdmin = async (req,res)=>{
  const {id} = req.params
  try{
    const deletedOrder = await AquaOrder.findByIdAndDelete(id)
    if(!deletedOrder){
      return res.status(404).json({success:false,message:"Order not found"})
    }
    return res.status(200).json({success:true,message:"Order deleted successfully"})
  }catch(error){
    return res.status(400).json({success:false,message:"Error deleting order"})
  }
}

const OrderOperations = {
  getAllOrders,
  getSingleOrderIdByUserId,
  getOrdersByUserId,
  getOrdersById,
  getOrderByTransactionId,
  createOrder,
  updateOrder,
  deleteOrder,
  createCodOrder,
  //admin routes
  AdminGetOrders,
  updateOrderByAdmin,
  deleteOrderByAdmin
};

export default OrderOperations;
