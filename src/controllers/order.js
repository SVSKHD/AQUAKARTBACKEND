import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import sendEmail from "../notifications/email/send-email.js";
import orderEmail  from "../utils/emailTemplates/orderEmail.js"
import moment from "moment";





const formatCurrencyINR = (amount) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(amount);
};


const formattedDeliveryDate = (date) =>{
 return moment(date).format("DD-MM-YYYY")
}

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
    const ordercreated = new AquaOrder(req.body);
    await ordercreated.save();

    const user = await AquaEcomUser.findById(req.body.user);
    if (!ordercreated) {
      return res
        .status(400)
        .json({ success: false, message: "Please try again" });
    }

    const message = `Welcome to Aquakart Family, We have successfully received the order "${ordercreated.orderId}"`;

    // Send WhatsApp message if user has a phone number
    if (user.phone) {
      sendWhatsAppMessage(user.phone, message);
    }
    if (user.email){
      const priceInr = `${formatCurrencyINR(ordercreated.totalAmount)}/-`
      const deliveryDate = formattedDeliveryDate(ordercreated.estimatedDelivery)
      const content = orderEmail(ordercreated,user.email, priceInr, deliveryDate)
      const emailResult = await sendEmail({
        email: user.email,
        subject: "Cash on Delivery Order Confirmation",
        message: "Cash on Delivery Order Confirmation - Hello Aquakart",
        content: content,
      });
      
      if(emailResult){
        return res.status(200).json({ success: true, data: ordercreated, emailResult: true });
      }
    }

    // Send email if the user has an email address
  
    return res.status(200).json({ success: true, data: ordercreated, emailResult: false });
  } catch (error) {
    res.status(500).json({
      success: false,
      message:
        "There was a problem creating the order, please try again later.",
      error: error.message, // It's helpful to send back a specific error message
    });
  }
};

const AdminGetOrders = async (req, res) => {
  try {
    const { id, transactionId, orderId, date } = req.params;

    // Construct the query object
    const query = {};
    if (id) query._id = mongoose.Types.ObjectId(id);
    if (transactionId) query.transactionId = transactionId;
    if (orderId) query.orderId = orderId;
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
    res.status(200).json({ orders });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

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
};

export default OrderOperations;
