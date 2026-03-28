import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js";
import { StandardCheckoutPayRequest } from "pg-sdk-node";
import getPhonePeClient from "../utils/phonepeClient.js";
import sendEmail from "../notifications/email/send-email.js";
import orderEmail from "../utils/emailTemplates/orderEmail.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import formatCurrencyINR from "../utils/currency.js";
import formattedDeliveryDate from "../utils/date.js";

const payPhonepe = async (req, res) => {
  const passedPayload = req.body;
  console.log(req.body);

  const createUserName = (email) => {
    if (email) {
      const usernamePart = email.split("@")[0];
      return usernamePart.split(".")[0] + ".";
    }
  };

  try {
    const getUserById = await AquaEcomUser.findById(passedPayload.user);
    if (!getUserById) {
      return res
        .status(404)
        .send({ message: "User not found", success: false });
    }

    let order = new AquaOrder({
      ...passedPayload,
      userName:
        getUserById.firstName ||
        getUserById.name ||
        createUserName(getUserById.email),
    });
    await order.save();

    const merchantTransactionId = passedPayload.transactionId;

    const client = getPhonePeClient();
    const request = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantTransactionId)
      .amount(passedPayload.totalAmount * 100)
      .redirectUrl(
        `https://aquakart.co.in/order/${merchantTransactionId}`,
      )
      .callbackUrl(
        `https://api.aquakart.co.in/v1/phonepe-verify/${merchantTransactionId}`,
      )
      .build();

    const response = await client.pay(request);

    return res.json({
      url: response.redirectUrl,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
      success: false,
    });
  }
};

const handlePhoneOrderCheck = async (req, res) => {
  const { id } = req.params;
  const transactionId = id;

  console.log(id);

  try {
    const client = getPhonePeClient();
    const statusResponse = await client.getOrderStatus(transactionId);

    const state = statusResponse.state;

    const orderData = {
      paymentStatus: state === "COMPLETED" ? "Paid" : "Failed",
      paymentGatewayDetails: statusResponse,
      orderType: "Payment Method(Phone-Pe-Gateway)",
    };

    if (statusResponse.paymentDetails && statusResponse.paymentDetails.length > 0) {
      const payment = statusResponse.paymentDetails[0];
      orderData.paymentInstrument = payment.paymentMode
        ? { type: payment.paymentMode }
        : {};
    }

    const updatedOrder = await AquaOrder.findOneAndUpdate(
      { transactionId },
      orderData,
      { new: true },
    );

    const user = await AquaEcomUser.findById(updatedOrder.user);
    if (user) {
      const phone = user.phone;
      const email = user.email;
      if (phone) {
        const message = `Welcome to Aquakart Family, We have successfully received the order "${updatedOrder.orderId}"`;
        sendWhatsAppMessage(phone, message);
      }
      if (email) {
        const priceInr = `${formatCurrencyINR(updatedOrder.totalAmount)}/-`;
        const deliveryDate = formattedDeliveryDate(
          updatedOrder.estimatedDelivery,
        );
        const content = orderEmail(
          updatedOrder,
          email,
          priceInr,
          deliveryDate,
        );
        await sendEmail({
          email: user.email,
          subject: "Order Confirmation",
          message: "Order Confirmation - Hello Aquakart",
          content: content,
        });
      }
    }

    if (state === "COMPLETED") {
      res.status(200).json({ success: true, data: updatedOrder });
    } else if (state === "PENDING") {
      res.status(200).json({ success: true, data: updatedOrder });
    } else if (state === "FAILED") {
      res.status(200).json({ success: true, data: updatedOrder });
    } else {
      res
        .status(400)
        .json({ success: false, message: "Unknown payment status" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

const paymentOperations = {
  payPhonepe,
  handlePhoneOrderCheck,
};

export default paymentOperations;
