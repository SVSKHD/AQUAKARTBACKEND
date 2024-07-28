import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js"; // Ensure you have the correct path
import crypto from "crypto";
import axios from "axios";
import sendEmail from "../notifications/email/send-email.js";
import orderTemplate from "../notifications/email/orderTemplate.js" 

const payPhonepe = async (req, res) => {
  const passedPayload = req.body;

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

    console.log(order)
    const merchantTransactionId = passedPayload.transactionId;
    const data = {
      merchantId: process.env.PHONEPE_MERCHANTID,
      merchantTransactionId,
      merchantUserId: passedPayload.user,
      name: getUserById.name || createUserName(getUserById.email),
      amount: passedPayload.totalAmount * 100,
      redirectUrl: `https://aquakart.co.in/order/${merchantTransactionId}`,
      redirectMode: "POST",
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

    const prod_URL = "https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay";
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

    // Check for TOO_MANY_REQUESTS response
    if (response.data && response.data.code === 'TOO_MANY_REQUESTS') {
      return res.status(429).json({
        success: false,
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again.',
        data: {},
      });
    }

    return res.json({
      url: response.data.data.instrumentResponse.redirectInfo.url,
    });
  } catch (error) {
    // console.error(error);
    res.status(500).send({
      message: error.message,
      success: false,
    });
  }
};
function getUserIdFromTransactionId(transactionId) {
  const parts = transactionId.split("-");
  return parts[1];
}

// const handlePhonePeOrder = async(req,res)=>{
  // console.log("req", req.body)
  // const { transactionId, merchantId } = req.body;
  // const userId = getUserIdFromTransactionId(transactionId);
  // const checksum =
  //     crypto
  //       .createHash("sha256")
  //       .update(
  //         `/pg/v1/status/${merchantId}/${transactionId}fb0244a9-34b5-48ae-a7a3-741d3de823d3`,
  //       )
  //       .digest("hex") + "###1";

  //   const options = {
  //     method: "GET",
  //     url: `https://api.phonepe.com/apis/hermes/pg/v1/status/${merchantId}/${transactionId}`,
  //     headers: {
  //       accept: "application/json",
  //       "Content-Type": "application/json",
  //       "X-VERIFY": checksum,
  //       "X-MERCHANT-ID": merchantId,
  //     },
  //   };
  //   const apiResponse = await axios.request(options);
  //   if (apiResponse.data) {
  //     const orderData = {
  //       paymentStatus: "Paid",
  //       paymentInstrument: apiResponse.data.data.paymentInstrument,
  //       paymentGatewayDetails: apiResponse.data,
  //       orderType: "Payment Method(Phone-Pe-Gateway)",
  //     };

  //     const updatedOrder = await AquaOrder.findOneAndUpdate(
  //       { transactionId },
  //       orderData,
  //       { new: true },
  //     );
  //     if (updatedOrder) {
  //       res.writeHead(302, {
  //         Location: `aquakart.co.in/order/${updatedOrder.transactionId}`,
  //       });
  //     }
// }

const handlePhonePeOrder = async (req, res) => {
  console.log("req", req.body);
  try {
    const { transactionId, merchantId } = req.body;
    const userId = getUserIdFromTransactionId(transactionId); // Ensure this function is defined

    const checksum =
      crypto
        .createHash("sha256")
        .update(
          `/pg/v1/status/${merchantId}/${transactionId}fb0244a9-34b5-48ae-a7a3-741d3de823d3`,
        )
        .digest("hex") + "###1";

    const options = {
      method: "GET",
      url: `https://api.phonepe.com/apis/hermes/pg/v1/status/${merchantId}/${transactionId}`,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": merchantId,
      },
    };

    const apiResponse = await axios.request(options);
    if (apiResponse.data) {
      const orderData = {
        paymentStatus: "Paid",
        paymentInstrument: apiResponse.data.data.paymentInstrument,
        paymentGatewayDetails: apiResponse.data,
        orderType: "Payment Method(Phone-Pe-Gateway)",
      };

      const updatedOrder = await AquaOrder.findOneAndUpdate(
        { transactionId },
        orderData,
        { new: true },
      );

      if (updatedOrder) {
        const fetchedUser = await AquaEcomUser.findById(updatedOrder.user);
        if (fetchedUser) {
          const emailContent = orderTemplate(
            fetchedUser.email,
            updatedOrder.items,
            updatedOrder.paymentStatus,
            updatedOrder.estimatedDelivery,
          ); // This function should return the HTML content of the email
          await sendEmail({
            email: fetchedUser.email,
            subject: `Thank You for Your Order!  - Aquakart`,
            message: "Happy Shopping",
            content: emailContent,
          });
        }
        res.writeHead(302, {
          Location: `/order/${updatedOrder.transactionId}`,
        });
        res.end(JSON.stringify({ user: fetchedUser }));
      } else {
        throw new Error("Order not found");
      }
    } else {
      res.status(400).json({ error: "Payment not successful" });
    }
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};
const paymentOperations = {
  payPhonepe,
  handlePhonePeOrder
};

export default paymentOperations;
