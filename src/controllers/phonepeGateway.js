import crypto from "crypto";
import axios from "axios";
import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js"; // Ensure you have the correct path
import sendEmail from "../notifications/email/send-email.js";
import orderEmail from "../utils/emailTemplates/orderEmail.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import formatCurrencyINR from "../utils/currency.js";
import formattedDeliveryDate from "../utils/date.js";
import { legacyOrderFields } from "./order.js";

// PhonePe merchantTransactionId: 1-38 chars, letters, digits, _ and -.
const TRANSACTION_ID = /^[A-Za-z0-9_-]{6,38}$/;
const PHONEPE_ORDER_TYPE = "Payment Method(Phone Pe Gateway)";

// POST /v1/order/pay (legacy storefront, login required). The customer comes
// from the token and the amount from server-side pricing, never the body.
const payPhonepe = async (req, res) => {
  const passedPayload = req.body || {};

  const createUserName = (email) => {
    if (email) {
      const usernamePart = email.split("@")[0]; // Get the part before '@'
      return `${usernamePart.split(".")[0]}.`; // Get the part before the first '.' and add '.' back
    }
    return undefined;
  };

  try {
    const getUserById = req.user;
    if (
      passedPayload.user &&
      String(passedPayload.user) !== String(getUserById._id)
    )
      return res.status(403).send({
        success: false,
        message: "Orders can only be placed for your own account",
      });

    const merchantTransactionId = String(passedPayload.transactionId || "");
    if (!TRANSACTION_ID.test(merchantTransactionId))
      return res.status(400).send({
        success: false,
        message:
          "transactionId must be 6-38 letters, digits, _ or - (PhonePe merchant transaction id)",
      });
    if (await AquaOrder.exists({ transactionId: merchantTransactionId }))
      return res.status(409).send({
        success: false,
        message: "This transactionId is already used by another order",
      });

    const order = new AquaOrder(
      await legacyOrderFields(req, {
        orderType: PHONEPE_ORDER_TYPE,
        paymentMethod: "PhonePe",
        paymentStatus: "Pending",
        transactionId: merchantTransactionId,
      }),
    );
    await order.save();

    const data = {
      merchantId: process.env.PHONEPE_MERCHANTID,
      merchantTransactionId,
      merchantUserId: String(getUserById._id),
      name: getUserById.name || createUserName(getUserById.email),
      // Paise, from the server-computed total.
      amount: Math.round(order.totalAmount * 100),
      redirectUrl: `https://aquakart.co.in/order/${merchantTransactionId}`,
      redirectMode: "REDIRECT",
      callbackUrl: `https://api.aquakart.co.in/v1/phonepe-verify/${merchantTransactionId}`,
      mobileNumber: passedPayload.number || getUserById.phone,
      paymentInstrument: {
        type: "PAY_PAGE",
      },
    };
    const payload = JSON.stringify(data);
    const payloadMain = Buffer.from(payload).toString("base64");
    const keyIndex = 1;
    const string = `${payloadMain}/pg/v1/pay${process.env.PHONEPE_KEY}`;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = `${sha256}###${keyIndex}`;

    const prod_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
    const options = {
      method: "POST",
      url: prod_URL,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": process.env.PHONEPE_MERCHANTID,
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
    // Cart/stock/address problems are the client's to fix.
    if (error?.status >= 400 && error?.status < 500)
      return res
        .status(error.status)
        .send({ success: false, message: error.message });
    console.error("PhonePe pay failed:", error?.message || error);
    return res.status(500).send({
      success: false,
      message: "Could not start the payment, please try again later.",
    });
  }
};

// PhonePe outcome -> paymentStatus. A success only counts as Paid when the
// amount PhonePe collected equals the order total.
export const paymentStatusFor = (phonepe, order) => {
  const code = phonepe?.code;
  if (code === "PAYMENT_SUCCESS") {
    const paid = Number(phonepe?.data?.amount);
    const expected = Math.round(Number(order.totalAmount) * 100);
    return Number.isFinite(paid) && paid === expected ? "Paid" : "Processing";
  }
  if (code === "PAYMENT_PENDING") return "Pending";
  if (code === "PAYMENT_ERROR" || code === "PAYMENT_DECLINED") return "Failed";
  return null; // unknown: leave the order unchanged
};

// POST /v1/phonepe-verify/:id: PhonePe's callback (public). The status is
// fetched from PhonePe with our checksum, so a caller cannot fake it.
const handlePhoneOrderCheck = async (req, res) => {
  const { id } = req.params;
  const transactionId = String(id || "");
  const merchantId = process.env.PHONEPE_MERCHANTID;

  if (!TRANSACTION_ID.test(transactionId))
    return res
      .status(400)
      .json({ success: false, message: "Invalid transaction id" });
  const url = `https://api.phonepe.com/apis/hermes/pg/v1/status/${merchantId}/${transactionId}`;
  const keyIndex = 1;
  const string = `/pg/v1/status/${merchantId}/${transactionId}${process.env.PHONEPE_KEY}`;
  const checksum = `${crypto.createHash("sha256").update(string).digest("hex")}###${keyIndex}`;

  try {
    const order = await AquaOrder.findOne({ transactionId });
    if (!order)
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    // Already paid: never downgrade it or notify again.
    if (order.paymentStatus === "Paid")
      return res.status(200).json({ success: true, data: order });

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": merchantId,
        accept: "application/json",
      },
    });

    if (response.data) {
      const paymentStatus = paymentStatusFor(response.data, order);
      if (!paymentStatus)
        return res
          .status(400)
          .json({ success: false, message: "Unknown payment status" });
      if (response.data.code === "PAYMENT_SUCCESS" && paymentStatus !== "Paid")
        console.error("PhonePe amount mismatch; order left for review", {
          transactionId,
          paidPaise: response.data?.data?.amount,
          expectedPaise: Math.round(Number(order.totalAmount) * 100),
        });
      const orderData = {
        paymentStatus,
        paymentInstrument: response.data.data?.paymentInstrument,
        paymentGatewayDetails: response.data,
        orderType: PHONEPE_ORDER_TYPE,
      };

      // Conditional: a concurrent callback that already set Paid wins, so
      // the confirmation is sent once.
      const updatedOrder = await AquaOrder.findOneAndUpdate(
        { _id: order._id, paymentStatus: { $ne: "Paid" } },
        orderData,
        { new: true },
      );
      if (!updatedOrder) {
        const current = await AquaOrder.findById(order._id);
        return res.status(200).json({ success: true, data: current });
      }

      // Confirmation only for a newly paid order (not failed/pending).
      const user =
        paymentStatus === "Paid"
          ? await AquaEcomUser.findById(updatedOrder.user)
          : null;
      if (user) {
        const { phone } = user;
        const { email } = user;
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
            subject: "Cash on Delivery Order Confirmation",
            message: "Cash on Delivery Order Confirmation - Hello Aquakart",
            content,
          });
        }
      }

      // Unknown PhonePe codes were rejected above, before any update.
      return res.status(200).json({ success: true, data: updatedOrder });
    }
    return res
      .status(502)
      .json({ success: false, message: "Empty response from PhonePe" });
  } catch (error) {
    console.error("PhonePe verify failed:", error?.message || error);
    return res.status(500).json({ error: "Payment verification failed" });
  }
};

const paymentOperations = {
  payPhonepe,
  handlePhoneOrderCheck,
};

export default paymentOperations;
