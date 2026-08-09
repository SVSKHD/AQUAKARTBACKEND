import crypto from "crypto";
import axios from "axios";

const merchantId = () => process.env.PHONEPE_MERCHANTID;
const saltKey = () => process.env.PHONEPE_KEY;
const keyIndex = () => process.env.PHONEPE_KEY_INDEX || "1";
const baseUrl = () =>
  process.env.PHONEPE_BASE_URL || "https://api.phonepe.com/apis/hermes";

export const createPhonePePayment = async ({
  transactionId,
  userId,
  amount,
  phone,
}) => {
  if (!merchantId() || !saltKey())
    throw Object.assign(new Error("PhonePe is not configured"), {
      status: 503,
    });
  const payload = {
    merchantId: merchantId(),
    merchantTransactionId: transactionId,
    merchantUserId: String(userId),
    amount: Math.round(amount * 100),
    redirectUrl: `${process.env.ECOM_BASE_URL || "https://aquakart.co.in"}/order/${transactionId}`,
    redirectMode: "REDIRECT",
    callbackUrl: `${process.env.API_BASE_URL || "https://api.aquakart.co.in"}/v1/webhooks/payments/phonepe/${transactionId}`,
    mobileNumber: String(phone || "")
      .replace(/\D/g, "")
      .slice(-10),
    paymentInstrument: { type: "PAY_PAGE" },
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const path = "/pg/v1/pay";
  const checksum = `${crypto.createHash("sha256").update(`${encoded}${path}${saltKey()}`).digest("hex")}###${keyIndex()}`;
  const response = await axios.post(
    `${baseUrl()}${path}`,
    { request: encoded },
    {
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
    },
  );
  return {
    redirectUrl: response.data?.data?.instrumentResponse?.redirectInfo?.url,
    transactionId: response.data?.data?.merchantTransactionId,
    raw: response.data,
  };
};

export const verifyPhonePePayment = async (transactionId) => {
  const path = `/pg/v1/status/${merchantId()}/${transactionId}`;
  const checksum = `${crypto.createHash("sha256").update(`${path}${saltKey()}`).digest("hex")}###${keyIndex()}`;
  const response = await axios.get(`${baseUrl()}${path}`, {
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      "X-VERIFY": checksum,
      "X-MERCHANT-ID": merchantId(),
    },
  });
  const code = response.data?.code;
  const status =
    code === "PAYMENT_SUCCESS"
      ? "paid"
      : code === "PAYMENT_PENDING"
        ? "pending"
        : "failed";
  return {
    status,
    amount: Number(response.data?.data?.amount || 0) / 100,
    raw: response.data,
  };
};
