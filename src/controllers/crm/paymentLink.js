import AquaPayment from "../../models/crm/paymentLink.js";
import crypto from "crypto";
import axios from "axios";
import mongoose from "mongoose";

const createPaymentLink = async (req, res) => {
  const { name, phone, email, amount, invoiceId } = req.body;

  try {
    if (!name || !phone || !email || !amount || !invoiceId) {
      return res.status(400).send({
        message: "Name, phone, email, amount, and invoiceId are required",
        success: false,
      });
    }

    // Validate invoiceId
    if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
      return res.status(400).send({
        message: "Invalid invoiceId",
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

    // Log the payload for debugging purposes
    console.log("Payload:", payload);
    console.log("Payload Main (Base64):", payloadMain);
    console.log("Checksum:", checksum);

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
    const responseData = response.data.data;

    // Save the payment link to the database
    const newPayment = new AquaPayment({
      invoiceId: mongoose.Types.ObjectId(invoiceId),
      paymentLink: responseData.payLink,
      paymentStatus: false,
      paymentinfo: {
        transactionId: responseData.transactionId,
        amount: responseData.amount,
        merchantId: responseData.merchantId,
        upiIntent: responseData.upiIntent,
        mobileNumber: responseData.mobileNumber,
      },
      userDetails: {
        phone: phone,
        name: name,
      },
    });

    await newPayment.save();

    return res.json({
      success: true,
      code: "SUCCESS",
      message: "Your request has been successfully completed.",
      data: {
        transactionId: responseData.transactionId,
        amount: responseData.amount / 100, // Converting back to original amount
        merchantId: responseData.merchantId,
        upiIntent: responseData.upiIntent,
        payLink: responseData.payLink,
        mobileNumber: responseData.mobileNumber,
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