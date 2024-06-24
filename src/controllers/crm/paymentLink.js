import AquaPayment from "../../models/crm/paymentLink.js";
import crypto from "crypto";
import axios from "axios";

const createPaymentLink = async (req, res) => {
  const { name, phone, email, amount, invoiceId, referenceId } = req.body;

  try {
    if (!name || !phone || !email || !amount || !invoiceId || !referenceId) {
      return res.status(400).send({
        message: "Name, phone, email, amount, invoiceId, and referenceId are required",
        success: false,
      });
    }

    // Create a unique transaction ID
    const merchantTransactionId = `AQTRPAYLINK_${Date.now()}`;
    const orderId = `AQTR_ODPAYLINK-${Date.now()}`

    const data = {
      "merchantId":process.env.PHONEPE_MERCHANTID,
      "transactionId":merchantTransactionId,
      "merchantOrderId":merchantTransactionId,
      "amount":amount*100,
      "mobileNumber":phone,
      "message":"paylink for 1 order",
      "expiresIn":3600,
      "storeId":"store1",
      "terminalId":"terminal1",
      "shortName":"DemoCustomer",
      "subMerchantId":"DemoMerchant",
    };

    const payload = JSON.stringify(data);
    const payloadMain = Buffer.from(payload).toString("base64");
    const keyIndex = 1;
    const string = payloadMain + "/v3/payLink/init" + process.env.PHONEPE_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;
    console.log("checksub", checksum , payloadMain)

    const prod_URL = "https://mercury-t2.phonepe.com/v3/payLink/init";
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
      referenceId: referenceId,  // Use the string directly
      invoiceId: invoiceId,  // Use the string directly
      paymentLink: responseData.payLink,
      paymentStatus: false,
      paymentinfo: {
        transactionId: responseData.transactionId,
        amount: responseData.amount,
        merchantId: responseData.merchantId,
        upiIntent: responseData.upiIntent,
        payUrl:responseData.payLink,
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