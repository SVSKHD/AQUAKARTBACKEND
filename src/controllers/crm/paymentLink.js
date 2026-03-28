import AquaPayment from "../../models/crm/paymentLink.js";
import { StandardCheckoutPayRequest } from "pg-sdk-node";
import getPhonePeClient from "../../utils/phonepeClient.js";

const createPaymentLink = async (req, res) => {
  const { name, phone, email, amount, invoiceId, referenceId } = req.body;

  try {
    if (!name || !phone || !email || !amount || !invoiceId || !referenceId) {
      return res.status(400).send({
        message:
          "Name, phone, email, amount, invoiceId, and referenceId are required",
        success: false,
      });
    }

    const merchantTransactionId = `AQTRPAYLINK_${Date.now()}`;

    const client = getPhonePeClient();
    const request = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantTransactionId)
      .amount(amount * 100)
      .redirectUrl(
        `https://aquakart.co.in/payment/status/${merchantTransactionId}`,
      )
      .build();

    const response = await client.pay(request);
    const payLink = response.redirectUrl;

    const newPayment = new AquaPayment({
      referenceId: referenceId,
      invoiceId: invoiceId,
      paymentLink: payLink,
      paymentStatus: false,
      paymentinfo: {
        transactionId: merchantTransactionId,
        amount: amount,
        merchantId: process.env.PHONEPE_CLIENT_ID,
        payUrl: payLink,
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
        transactionId: merchantTransactionId,
        amount: amount,
        merchantId: process.env.PHONEPE_CLIENT_ID,
        payLink: payLink,
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
