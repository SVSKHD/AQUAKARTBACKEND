import AquaPayment from "../../models/crm/paymentLink.js";
import crypto from "crypto";
import axios from "axios";

const createPaymentLink = async (req, res) => {
  const { user, paymentDetails } = req.body;
  try {
    if (!user) {
      return res
        .status(404)
        .send({ message: "user information is required", success: false });
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
      merchantId: process.env.MERCHANTID,
      merchantTransactionId,
      merchantUserId: passedPayload.user,
      name: paymentDetails.user.name,
      amount: paymentDetails.totalAmount * 100,
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

const PaymentOperations = {
  createPaymentLink,
};

export default PaymentOperations;
