import { EventEmitter } from "events";
import CrmNotification from "../models/crm/notification.js";

const notificationBus = new EventEmitter();
notificationBus.setMaxListeners(100);

export const CRM_NOTIFICATION_EVENT = "crm-notification";

const normalizePayload = (payload = {}) => ({
  type: String(payload.type || "").trim(),
  entityType: String(payload.entityType || "").trim(),
  entityId: payload.entityId || null,
  title: String(payload.title || "").trim(),
  message: String(payload.message || "").trim(),
  severity: payload.severity || "info",
  eventKey: payload.eventKey ? String(payload.eventKey).trim() : undefined,
  metadata: payload.metadata || {},
});

export const publishCrmNotification = async (payload = {}) => {
  const normalized = normalizePayload(payload);

  if (!normalized.type || !normalized.entityType) {
    throw new Error("CRM notification type and entityType are required");
  }
  if (!normalized.title || !normalized.message) {
    throw new Error("CRM notification title and message are required");
  }

  let notification;
  try {
    notification = await CrmNotification.create(normalized);
  } catch (error) {
    if (error?.code === 11000 && normalized.eventKey) {
      notification = await CrmNotification.findOne({
        eventKey: normalized.eventKey,
      });
      if (notification) return notification;
    }
    throw error;
  }

  notificationBus.emit(
    CRM_NOTIFICATION_EVENT,
    notification.toObject ? notification.toObject() : notification,
  );

  return notification;
};

export const publishCrmNotificationSafely = async (payload = {}) => {
  try {
    return await publishCrmNotification(payload);
  } catch (error) {
    console.error("CRM notification publish failed:", error);
    return null;
  }
};

export const subscribeToCrmNotifications = (listener) => {
  notificationBus.on(CRM_NOTIFICATION_EVENT, listener);
  return () => notificationBus.off(CRM_NOTIFICATION_EVENT, listener);
};

export const buildOrderCreatedNotification = ({
  order,
  source = "ecommerce",
  customerName = "",
  amount,
}) => {
  const orderNumber =
    order?.orderNumber || order?.orderId || String(order?._id || "");
  const total = Number(
    amount ?? order?.grandTotal ?? order?.totalAmount ?? order?.total ?? 0,
  );
  const sourceLabel =
    source === "crm" ? "CRM Order" : source === "cod" ? "COD Order" : "Ecommerce Order";
  const customer =
    customerName ||
    order?.customer?.name ||
    order?.shippingAddress?.name ||
    "";

  return {
    type: "order.created",
    entityType: "order",
    entityId: order?._id,
    title: `New ${sourceLabel}`,
    message: [
      orderNumber,
      customer,
      total > 0 ? `₹${total.toLocaleString("en-IN")}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    severity: "success",
    eventKey: order?._id ? `order.created:${order._id}` : undefined,
    metadata: {
      orderNumber,
      customerName: customer,
      amount: total,
      source,
    },
  };
};
