import AquaPayment from "../../models/crm/paymentLink.js";
import crypto from "crypto";
import axios from "axios";

const createPaymentLink = async (req, res) => {
  const { name, phone, email, amount } = req.body;

  try {
    if (!name || !phone || !email || !amount) {
      return res.status(400).send({
        message: "Name, phone, email, and amount are required",
        success: false,
      });
    }

    // Create a unique transaction ID
    const merchantTransactionId = `TRANS_${Date.now()}`;

    const data = {
      merchantId: process.env.MERCHANTID,
      merchantTransactionId,
      merchantUserId: email,
      name: name,
      amount: amount * 100, // Amount in paise
      redirectUrl: `https://yourdomain.com/api/order/${merchantTransactionId}`,
      redirectMode: "POST",
      callbackUrl: `https://yourdomain.com/api/order/${merchantTransactionId}`,
      mobileNumber: phone,
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
    const responseData = response.data.data.instrumentResponse.redirectInfo;

    return res.json({
      success: true,
      code: "SUCCESS",
      message: "Your request has been successfully completed.",
      data: {
        transactionId: merchantTransactionId,
        amount: amount,
        merchantId: process.env.MERCHANTID,
        upiIntent: responseData.upiIntent,
        payLink: responseData.url,
        mobileNumber: phone,
      },
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