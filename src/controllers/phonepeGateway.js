import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js"; // Ensure you have the correct path
import crypto from "crypto";
import axios from "axios";

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

    const merchantTransactionId = passedPayload.transactionId;
    const data = {
      merchantId: process.env.PHONEPE_MERCHANTID,
      merchantTransactionId,
      merchantUserId: passedPayload.user,
      name: getUserById.name || createUserName(getUserById.email),
      amount: passedPayload.totalAmount * 100,
      redirectUrl: `https://aquakart.co.in/api/order/${merchantTransactionId}`,
      redirectMode: "POST",
      callbackUrl: `https://aquakart.co.in/api/order/${merchantTransactionId}`,
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

const paymentOperations = {
  payPhonepe,
};

export default paymentOperations;
