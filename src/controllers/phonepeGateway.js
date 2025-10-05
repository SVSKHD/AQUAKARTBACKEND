import AquaOrder from "../models/orders.js";
import AquaEcomUser from "../models/user.js"; // Ensure you have the correct path
import {
  Env,
  MetaInfo,
  StandardCheckoutClient,
  StandardCheckoutPayRequest,
} from "pg-sdk-node";
import sendEmail from "../notifications/email/send-email.js";
import orderEmail from "../utils/emailTemplates/orderEmail.js";
import sendWhatsAppMessage from "../utils/sendWhatsApp.js";
import formatCurrencyINR from "../utils/currency.js";
import formattedDeliveryDate from "../utils/date.js";

let phonePeClient;

const resolvePhonePeEnv = (envValue = "SANDBOX") =>
  envValue.toUpperCase() === "PRODUCTION" ? Env.PRODUCTION : Env.SANDBOX;

const getPhonePeClient = () => {
  if (phonePeClient) {
    return phonePeClient;
  }

  const clientId = process.env.PHONEPE_CLIENT_ID;
  const clientSecret = process.env.PHONEPE_CLIENT_SECRET;
  const clientVersionRaw = process.env.PHONEPE_CLIENT_VERSION;

  if (!clientId || !clientSecret || !clientVersionRaw) {
    throw new Error(
      "PhonePe configuration missing: PHONEPE_CLIENT_ID/PHONEPE_CLIENT_SECRET/PHONEPE_CLIENT_VERSION",
    );
  }

  const clientVersion = Number(clientVersionRaw);

  if (Number.isNaN(clientVersion)) {
    throw new Error(
      "PhonePe configuration invalid: PHONEPE_CLIENT_VERSION must be numeric",
    );
  }

  const env = resolvePhonePeEnv(process.env.PHONEPE_ENV);

  phonePeClient = StandardCheckoutClient.getInstance(
    clientId,
    clientSecret,
    clientVersion,
    env,
  );

  return phonePeClient;
};

const mapPhonePeStateToPaymentStatus = (state) => {
  const normalizedState = (state || "").toUpperCase();

  switch (normalizedState) {
    case "COMPLETED":
    case "SUCCESS":
      return "Paid";
    case "PENDING":
    case "INITIATED":
      return "Pending";
    case "PROCESSING":
      return "Processing";
    default:
      return "Failed";
  }
};


const payPhonepe = async (req, res) => {
  const passedPayload = req.body;
  console.log(req.body);

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

    const client = getPhonePeClient();

    const merchantTransactionId = passedPayload.transactionId;
    const redirectUrl = `https://aquakart.co.in/order/${merchantTransactionId}`;
    const callbackUrl = `https://api.aquakart.co.in/v1/phonepe-verify/${merchantTransactionId}`;

    const metaInfoValues = [
      passedPayload.user ? String(passedPayload.user) : undefined,
      passedPayload.number ? String(passedPayload.number) : undefined,
      getUserById.email || undefined,
      callbackUrl,
      process.env.PHONEPE_MERCHANTID,
    ];

    const hasMetaInfo = metaInfoValues.some((value) => value !== undefined);
    const metaInfo = hasMetaInfo
      ? new MetaInfo(...metaInfoValues)
      : undefined;

    const payRequestBuilder = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantTransactionId)
      .amount(passedPayload.totalAmount * 100)
      .redirectUrl(redirectUrl)
      .message(`Aquakart order ${merchantTransactionId}`);

    if (metaInfo) {
      payRequestBuilder.metaInfo(metaInfo);
    }

    const payResponse = await client.pay(payRequestBuilder.build());

    return res.json({
      url: payResponse.redirectUrl,
      orderId: payResponse.orderId,
      state: payResponse.state,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
      success: false,
    });
  }
};

const handlePhoneOrderCheck = async (req, res) => {
  const { id } = req.params;
  const transactionId = id;
  const callbackPayload = req.body ?? {};

  let client;

  try {
    client = getPhonePeClient();
  } catch (configError) {
    console.error(configError);
    return res.status(500).json({
      success: false,
      message: configError.message,
    });
  }

  try {
    const statusResponse = await client.getOrderStatus(transactionId, true);

    if (statusResponse) {
      const statusData = JSON.parse(JSON.stringify(statusResponse));
      const paymentDetails = Array.isArray(statusData.paymentDetails)
        ? statusData.paymentDetails
        : [];
      const latestPaymentDetail = paymentDetails[0];
      const paymentState =
        latestPaymentDetail?.state || statusData.state || "UNKNOWN";

      const orderData = {
        paymentStatus: mapPhonePeStateToPaymentStatus(paymentState),
        paymentInstrument:
          latestPaymentDetail?.instrument ||
          callbackPayload?.data?.paymentInstrument,
        paymentGatewayDetails: {
          statusResponse: statusData,
          callbackPayload,
        },
        orderType: "Payment Method(Phone Pe Gateway)",
      };

      const updatedOrder = await AquaOrder.findOneAndUpdate(
        { transactionId },
        orderData,
        { new: true },
      );

      if (!updatedOrder) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      const triggerNotifications = async () => {
        try {
          const user = await AquaEcomUser.findById(updatedOrder.user);

          if (!user) {
            return;
          }

          const phone = user.phone;
          const email = user.email;

          if (phone) {
            try {
              await sendWhatsAppMessage(
                phone,
                `Welcome to Aquakart Family, We have successfully received the order "${updatedOrder.orderId}"`,
              );
            } catch (whatsAppError) {
              console.error(
                "Failed to send WhatsApp notification",
                whatsAppError,
              );
            }
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

            try {
              await sendEmail({
                email: user.email,
                subject: "Cash on Delivery Order Confirmation",
                message: "Cash on Delivery Order Confirmation - Hello Aquakart",
                content,
              });
            } catch (emailError) {
              console.error("Failed to send email notification", emailError);
            }
          }
        } catch (userFetchError) {
          console.error(
            "Failed to fetch user for notifications",
            userFetchError,
          );
        }
      };

      const payload = {
        success: true,
        data: updatedOrder,
        gatewayState: paymentState,
      };

      const normalizedState = paymentState.toUpperCase();
      const knownStates = new Set([
        "COMPLETED",
        "SUCCESS",
        "FAILED",
        "PENDING",
        "PROCESSING",
        "INITIATED",
      ]);

      if (knownStates.has(normalizedState)) {
        res.status(200).json(payload);
        Promise.resolve()
          .then(() => triggerNotifications())
          .catch((notificationError) => {
            console.error(
              "PhonePe notification dispatch failed",
              notificationError,
            );
          });
      } else {
        res
          .status(400)
          .json({ success: false, message: "Unknown payment status" });
      }
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

const paymentOperations = {
  payPhonepe,
  handlePhoneOrderCheck,
};

export default paymentOperations;
