import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js"; // Ensure you have the correct path
import crypto from "crypto";
import axios from "axios";
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
      const usernamePart = email.split("@")[0]; // Get the part before '@'
      return usernamePart.split(".")[0] + "."; // Get the part before the first '.' and add '.' back
    }
  };

  try {
    const getUserById = await AquaEcomUser.findById(passedPayload.user); // Await the async call to find user
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
    await order.save(); // Save the order with proper await

    const merchantTransactionId = passedPayload.transactionId;
    const data = {
      merchantId: process.env.PHONEPE_MERCHANTID,
      merchantTransactionId,
      merchantUserId: passedPayload.user,
      name: getUserById.name || createUserName(getUserById.email),
      amount: passedPayload.totalAmount * 100,
      redirectUrl: `https://aquakart.co.in/order/${merchantTransactionId}`,
      redirectMode: "REDIRECT",
      callbackUrl: `https://api.aquakart.co.in/v1/phonepe-verify/${merchantTransactionId}`,
      mobileNumber: passedPayload.number,
      paymentInstrument: {
        type: "PAY_PAGE",
      },
    };
    const payload = JSON.stringify(data);
    const payloadMain = Buffer.from(payload).toString("base64");
    const keyIndex = 1;
    const string = payloadMain + "/pg/v1/pay" + process.env.PHONEPE_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    const prod_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
    const options = {
      method: "POST",
      url: prod_URL,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
      data: {
        request: payloadMain,
      },
    };

    const response = await axios.request(options);
    return res.json({
      url: response.data.data.instrumentResponse.redirectInfo.url,
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
  const callbackPayload = req.body ?? {};
  const merchantId = process.env.PHONEPE_MERCHANTID;

  console.log(id);
  const url = `https://api.phonepe.com/apis/hermes/pg/v1/status/${merchantId}/${transactionId}`;
  const checksum =
    crypto
      .createHash("sha256")
      .update(
        `/pg/v1/status/${merchantId}/${transactionId}fb0244a9-34b5-48ae-a7a3-741d3de823d3`,
      )
      .digest("hex") + "###1";

  try {
    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": merchantId,
        accept: "application/json",
      },
    });

    if (response.data) {
      const { code, data: gatewayData } = response.data;
      let paymentStatus;

      switch (code) {
        case "PAYMENT_SUCCESS":
          paymentStatus = "Paid";
          break;
        case "PAYMENT_PENDING":
          paymentStatus = "Pending";
          break;
        default:
          paymentStatus = "Failed";
      }

      const orderData = {
        paymentStatus,
        paymentInstrument:
          gatewayData?.paymentInstrument ||
          callbackPayload?.data?.paymentInstrument,
        paymentGatewayDetails: {
          statusResponse: response.data,
          callbackPayload,
        },
        orderType: "Payment Method(Phone Pe Gateway)",
      };

      const updatedOrder = await AquaOrder.findOneAndUpdate(
        { transactionId },
        orderData,
        { new: true },
      );

      if (!updatedOrder) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      const redirectUrl = `https://aquakart.co.in/order/${transactionId}`;

      const triggerNotifications = async () => {
        try {
          const user = await AquaEcomUser.findById(updatedOrder.user);

          if (!user) {
            return;
          }

          const phone = user.phone;
          const email = user.email;

          if (phone) {
            try {
              await sendWhatsAppMessage(
                phone,
                `Welcome to Aquakart Family, We have successfully received the order "${updatedOrder.orderId}"`,
              );
            } catch (whatsAppError) {
              console.error(
                "Failed to send WhatsApp notification",
                whatsAppError,
              );
            }
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

            try {
              await sendEmail({
                email: user.email,
                subject: "Cash on Delivery Order Confirmation",
                message: "Cash on Delivery Order Confirmation - Hello Aquakart",
                content,
              });
            } catch (emailError) {
              console.error("Failed to send email notification", emailError);
            }
          }
        } catch (userFetchError) {
          console.error(
            "Failed to fetch user for notifications",
            userFetchError,
          );
        }
      };

      const payload = { success: true, data: updatedOrder };

      if (code === "PAYMENT_SUCCESS") {
        res.status(200).json(payload);
        Promise.resolve().then(() => triggerNotifications());
      } else if (code === "PAYMENT_ERROR") {
        res.status(200).json(payload);
        Promise.resolve().then(() => triggerNotifications());
      } else if (code === "PAYMENT_PENDING") {
        res.status(200).json(payload);
        Promise.resolve().then(() => triggerNotifications());
      } else {
        res
          .status(400)
          .json({ success: false, message: "Unknown payment status" });
      }
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
