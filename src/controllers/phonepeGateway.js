import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js"; // Ensure you have the correct path
import sendEmail from "../notifications/email/send-email.js";
import orderEmail from "../utils/emailTemplates/orderEmail.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import formatCurrencyINR from "../utils/currency.js";
import formattedDeliveryDate from "../utils/date.js";
import { legacyOrderFields } from "./order.js";
import {
  fireAndForget,
  isPaymentTemplateConfigured,
  notifyStorefrontOrderPaid,
} from "../services/notifications/paymentNotifications.js";
import {
  createPhonePePayment,
  verifyPhonePePayment,
} from "../services/gateways/phonepe.js";

const ECOM_BASE = (
  process.env.ECOM_BASE_URL || "https://aquakart.co.in"
).replace(/\/$/, "");
const API_BASE = (
  process.env.API_BASE_URL || "https://api.aquakart.co.in"
).replace(/\/$/, "");

// PhonePe merchantTransactionId: 1-38 chars, letters, digits, _ and -.
const TRANSACTION_ID = /^[A-Za-z0-9_-]{6,38}$/;
const PHONEPE_ORDER_TYPE = "Payment Method(Phone Pe Gateway)";

// POST /v1/order/pay (legacy storefront, login required). The customer comes
// from the token and the amount from server-side pricing, never the body.
const payPhonepe = async (req, res) => {
  const passedPayload = req.body || {};

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

    // Shared gateway (v1 or v2 by PHONEPE_API_VERSION). The v1 callback
    // stays on this route; v2 uses the dashboard webhook.
    const result = await createPhonePePayment({
      transactionId: merchantTransactionId,
      userId: getUserById._id,
      amount: order.totalAmount,
      phone: passedPayload.number || getUserById.phone,
      redirectUrl: `${ECOM_BASE}/order/${merchantTransactionId}`,
      callbackUrl: `${API_BASE}/v1/phonepe-verify/${merchantTransactionId}`,
    });
    if (!result?.redirectUrl)
      throw new Error("PhonePe returned no payment page");
    return res.json({ url: result.redirectUrl });
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
// amount PhonePe collected equals the order total. Takes the gateway's
// verification (v1 codes or v2 states, amount in rupees) or a raw v1
// response ({ code, data: { amount } } in paise).
const paidPaise = (phonepe) => {
  if (phonepe?.data?.amount !== undefined) return Number(phonepe.data.amount);
  if (phonepe?.amount !== undefined)
    return Math.round(Number(phonepe.amount) * 100);
  return NaN;
};
export const paymentStatusFor = (phonepe, order) => {
  const code = phonepe?.code;
  if (code === "PAYMENT_SUCCESS" || code === "COMPLETED") {
    const paid = paidPaise(phonepe);
    const expected = Math.round(Number(order.totalAmount) * 100);
    return Number.isFinite(paid) && paid === expected ? "Paid" : "Processing";
  }
  if (code === "PAYMENT_PENDING" || code === "PENDING") return "Pending";
  if (["PAYMENT_ERROR", "PAYMENT_DECLINED", "FAILED"].includes(code))
    return "Failed";
  return null; // unknown: leave the order unchanged
};

// Checks a legacy order's payment with PhonePe and updates it. Used by the v1
// callback (POST /v1/phonepe-verify/:id) and the v2 webhook. The status is
// fetched from PhonePe with our credentials, so a caller cannot fake it.
// Returns { status, body } for the HTTP response.
export const reconcileLegacyOrder = async (transactionId) => {
  const order = await AquaOrder.findOne({ transactionId });
  if (!order)
    return {
      status: 404,
      body: { success: false, message: "Order not found" },
    };
  // Already paid: never downgrade it or notify again.
  if (order.paymentStatus === "Paid")
    return { status: 200, body: { success: true, data: order } };

  const verification = await verifyPhonePePayment(transactionId);
  if (!verification?.raw)
    return {
      status: 502,
      body: { success: false, message: "Empty response from PhonePe" },
    };
  const paymentStatus = paymentStatusFor(verification, order);
  if (!paymentStatus)
    return {
      status: 400,
      body: { success: false, message: "Unknown payment status" },
    };
  if (verification.status === "paid" && paymentStatus !== "Paid")
    console.error("PhonePe amount mismatch; order left for review", {
      transactionId,
      paidPaise: paidPaise(verification),
      expectedPaise: Math.round(Number(order.totalAmount) * 100),
    });
  const orderData = {
    paymentStatus,
    paymentInstrument: verification.instrument,
    paymentGatewayDetails: verification.raw,
    orderType: PHONEPE_ORDER_TYPE,
  };

  // Conditional: a concurrent callback that already set Paid wins, so the
  // confirmation is sent once.
  const updatedOrder = await AquaOrder.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: "Paid" } },
    orderData,
    { new: true },
  );
  if (!updatedOrder) {
    const current = await AquaOrder.findById(order._id);
    return { status: 200, body: { success: true, data: current } };
  }

  // Confirmation only for a newly paid order (not failed/pending).
  const user =
    paymentStatus === "Paid"
      ? await AquaEcomUser.findById(updatedOrder.user)
      : null;
  if (paymentStatus === "Paid")
    fireAndForget("Legacy order paid", () =>
      notifyStorefrontOrderPaid({ order: updatedOrder, user }),
    );
  if (user) {
    const { phone } = user;
    const { email } = user;
    // The Fast2SMS order-confirmed template replaces this free-text message
    // once it is configured.
    if (phone && !isPaymentTemplateConfigured("orderConfirmed")) {
      const message = `Welcome to Aquakart Family, We have successfully received the order "${updatedOrder.orderId}"`;
      sendWhatsAppMessage(phone, message);
    }
    if (email) {
      const priceInr = `${formatCurrencyINR(updatedOrder.totalAmount)}/-`;
      const deliveryDate = formattedDeliveryDate(
        updatedOrder.estimatedDelivery,
      );
      const content = orderEmail(updatedOrder, email, priceInr, deliveryDate);
      await sendEmail({
        email: user.email,
        subject: "Cash on Delivery Order Confirmation",
        message: "Cash on Delivery Order Confirmation - Hello Aquakart",
        content,
      });
    }
  }
  return { status: 200, body: { success: true, data: updatedOrder } };
};

// POST /v1/phonepe-verify/:id: the v1 callback and the /order page's check.
const handlePhoneOrderCheck = async (req, res) => {
  const transactionId = String(req.params.id || "");
  if (!TRANSACTION_ID.test(transactionId))
    return res
      .status(400)
      .json({ success: false, message: "Invalid transaction id" });
  try {
    const { status, body } = await reconcileLegacyOrder(transactionId);
    return res.status(status).json(body);
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
