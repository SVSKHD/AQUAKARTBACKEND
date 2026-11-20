# Payment-success notifications (Fast2SMS)

Last reviewed: 2026-11-20 (Asia/Calcutta). Verify details in source:

- **Service:** `src/services/notifications/paymentNotifications.js`
- **Hooks:**
  - `src/controllers/payments.js` (`finalize`, storefront checkout)
  - `src/controllers/phonepeGateway.js` (legacy PhonePe callback)
  - `src/services/offlinePayments/service.js` + `index.js` (payment links)
  - `src/controllers/crm/orderInvoice.js` (invoice generated from an order)
  - `src/controllers/offlinePayments.js` (payment link created)
- **Log:** `NotificationLog` (`event`, `reference`, unique `dedupeKey`)
- **Tests:** `test/paymentNotifications.test.js`, `test/offlinePayments.test.js`

## What is sent

| Event                | To                                        | When                                                                         |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `paymentLinkRequest` | The customer on the pre-invoice/quotation | Staff create or regenerate a payment link (`notifyCustomer: false` skips it) |
| `adminOrderAlert`    | `ORDER_ALERT_PHONES` (default 9014774667) | A storefront order or a CRM payment link is verified paid                    |
| `orderConfirmed`     | The storefront customer                   | Their order is verified paid (includes the order link)                       |
| `paymentReceived`    | The payment-link customer                 | The final invoice is created after payment (includes invoice link)           |
| existing invoice     | The storefront customer                   | CRM generates the invoice from their order (`…/ecom-orders` invoice)         |

- **Order of events.** The admin alert goes out as soon as the payment is
  verified, even when invoice creation is blocked (for example stock short).
  The customer's payment receipt waits until the invoice exists.
- **Channel.** WhatsApp template first; the DLT SMS template if WhatsApp fails
  or has no template ID. An event with neither configured is skipped silently.
- **Once only.** Each message has a dedupe key (`order:<id>:…`,
  `payment-link:<id>:…`, `invoice:<id>:…`). Webhook retries, admin reconcile
  and status polling never send twice. A failed send is retried by the next
  verification of the same payment.
- **Never blocks payment.** Sends run in the background after the payment is
  saved; errors are logged, not returned.
- **No double invoice message.** With `paymentReceived` configured, the
  payment-link invoice skips the generic invoice template (`persistInvoice`
  `autoDeliver: false`). If the receipt then fails on both channels, the
  generic invoice template is sent instead. Without it, the generic invoice
  template is sent as before.
- **Legacy PhonePe.** Its free-text WhatsApp (whatsera) confirmation is sent
  only while `orderConfirmed` is not configured. The email is unchanged.

## Template list

| #   | Event                | Purpose                                               | WhatsApp template name       | WhatsApp env                                    | SMS (DLT) env                              |
| --- | -------------------- | ----------------------------------------------------- | ---------------------------- | ----------------------------------------------- | ------------------------------------------ |
| 1   | `adminOrderAlert`    | New paid order alert to 9014774667                    | `aquakart_admin_order_alert` | `FAST2SMS_WHATSAPP_ADMIN_ORDER_MESSAGE_ID`      | `FAST2SMS_SMS_ADMIN_ORDER_MESSAGE_ID`      |
| 2   | `orderConfirmed`     | Website order paid, order link                        | `aquakart_order_confirmed`   | `FAST2SMS_WHATSAPP_ORDER_CONFIRMED_MESSAGE_ID`  | `FAST2SMS_SMS_ORDER_CONFIRMED_MESSAGE_ID`  |
| 3   | `paymentReceived`    | Payment link paid, invoice link                       | `aquakart_payment_received`  | `FAST2SMS_WHATSAPP_PAYMENT_RECEIVED_MESSAGE_ID` | `FAST2SMS_SMS_PAYMENT_RECEIVED_MESSAGE_ID` |
| 4   | `paymentLinkRequest` | Payment link sent to the customer to pay              | `aquakart_payment_link`      | `FAST2SMS_WHATSAPP_PAYMENT_LINK_MESSAGE_ID`     | None (WhatsApp only)                       |
| -   | existing invoice     | Invoice link (CRM invoices, order invoices, fallback) | existing invoice template    | `FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID`          | `FAST2SMS_SMS_INVOICE_MESSAGE_ID`          |

That is 4 new WhatsApp templates and 3 new DLT SMS templates. The existing
invoice template ([FAST2SMS_WHATSAPP.md](FAST2SMS_WHATSAPP.md)) is unchanged
and sends customer name, invoice number, invoice link.

## Templates to create in Fast2SMS

Create the templates in the Fast2SMS dashboard, then copy each approved
**message ID** into the environment variable named under it.

- **WhatsApp:** Fast2SMS → WhatsApp → Templates → Create. Meta approves them.
- **SMS:** register the text on your DLT portal (Jio/Vi/Airtel…) under the
  approved sender ID, then add it in Fast2SMS → DLT Manager to get its message
  ID. Each `{#var#}` takes at most 30 characters, and the
  `https://aquakart.co.in` link must be whitelisted (CTA/URL whitelisting) on
  the DLT portal or operators block the SMS.

**Keep the variable order exactly as listed**: the backend sends the values in
that order. Fast2SMS separates values with `|`, so the backend replaces any `|`
inside a value (invoice numbers such as `AQB…|20112026`) with `/`.

The texts below follow Meta's rules: the body does not start or end with a
variable, no two variables are adjacent, and there is no promotional wording
(so they qualify as **Utility**). Enter the sample values shown when
submitting; Meta rejects templates without samples.

### 1. Admin order alert (`adminOrderAlert`)

Sent to `ORDER_ALERT_PHONES` (default 9014774667).

**WhatsApp**: `FAST2SMS_WHATSAPP_ADMIN_ORDER_MESSAGE_ID`

| Field    | Value                        |
| -------- | ---------------------------- |
| Name     | `aquakart_admin_order_alert` |
| Category | Utility                      |
| Language | English                      |
| Header   | Text: `New paid order`       |
| Footer   | `Aquakart`                   |
| Buttons  | None                         |

```text
A new order has been paid on Aquakart.

Order type: {{1}}
Reference: {{2}}
Customer: {{3}}
Mobile: {{4}}
Amount paid: Rs {{5}}

Please confirm stock and schedule delivery and installation.
```

| Variable | Value sent                          | Sample          |
| -------- | ----------------------------------- | --------------- |
| `{{1}}`  | `Website order` or `Payment link`   | `Website order` |
| `{{2}}`  | Order id or pre-invoice/quotation # | `AQOD-17321045` |
| `{{3}}`  | Customer name                       | `Ravi Kumar`    |
| `{{4}}`  | Customer mobile                     | `9876543210`    |
| `{{5}}`  | Amount, Indian format               | `25,999`        |

**SMS (DLT)**: `FAST2SMS_SMS_ADMIN_ORDER_MESSAGE_ID`. Content type: Service
Implicit.

```text
Aquakart: New {#var#} paid. Ref {#var#}, customer {#var#}, mobile {#var#}, amount Rs {#var#}. Please process the order. - AQUAKART
```

Same five variables in the same order.

### 2. Order confirmed (`orderConfirmed`)

Sent to the storefront customer when their order is paid.

**WhatsApp**: `FAST2SMS_WHATSAPP_ORDER_CONFIRMED_MESSAGE_ID`

| Field    | Value                       |
| -------- | --------------------------- |
| Name     | `aquakart_order_confirmed`  |
| Category | Utility                     |
| Language | English                     |
| Header   | Text: `Order confirmed`     |
| Footer   | `Aquakart - aquakart.co.in` |
| Buttons  | None                        |

```text
Hi {{1}}, thank you for your order with Aquakart.

We have received your payment for order {{2}}.
Amount paid: Rs {{3}}

You can view your order here: {{4}}

Our team will call you shortly to confirm the delivery and installation slot.
```

| Variable | Value sent      | Sample                                          |
| -------- | --------------- | ----------------------------------------------- |
| `{{1}}`  | Customer name   | `Ravi Kumar`                                    |
| `{{2}}`  | Order id        | `AQOD-17321045`                                 |
| `{{3}}`  | Amount          | `25,999`                                        |
| `{{4}}`  | Full order link | `https://aquakart.co.in/order/AQTR-1732-9F3A2B` |

**SMS (DLT)**: `FAST2SMS_SMS_ORDER_CONFIRMED_MESSAGE_ID`. Content type:
Service Implicit.

```text
Dear {#var#}, payment received for your Aquakart order {#var#} of Rs {#var#}. View order: https://aquakart.co.in/order/{#var#} - AQUAKART
```

Variables: 1 name, 2 order id, 3 amount, 4 transaction id only (for example
`AQTR-1732-9F3A2B`). The domain is fixed in the template because of the
30-character limit and URL whitelisting.

### 3. Payment received + invoice (`paymentReceived`)

Sent to the payment-link customer once the invoice is created.

**WhatsApp**: `FAST2SMS_WHATSAPP_PAYMENT_RECEIVED_MESSAGE_ID`

| Field    | Value                       |
| -------- | --------------------------- |
| Name     | `aquakart_payment_received` |
| Category | Utility                     |
| Language | English                     |
| Header   | Text: `Payment received`    |
| Footer   | `Aquakart - aquakart.co.in` |
| Buttons  | None                        |

```text
Hi {{1}}, we have received your payment of Rs {{2}} against {{3}}.

Your invoice {{4}} is ready. You can view and download it here: {{5}}

Thank you for choosing Aquakart.
```

| Variable | Value sent                   | Sample                                                    |
| -------- | ---------------------------- | --------------------------------------------------------- |
| `{{1}}`  | Customer name                | `Ravi Kumar`                                              |
| `{{2}}`  | Amount                       | `29,000`                                                  |
| `{{3}}`  | Pre-invoice/quotation number | `AQPI/20261120/0001`                                      |
| `{{4}}`  | Invoice number               | `AQB7kP2xQ9aLm/20112026`                                  |
| `{{5}}`  | Full invoice link            | `https://aquakart.co.in/invoice/64b0f1c2a9e4d3b2c1a09f87` |

**SMS (DLT)**: `FAST2SMS_SMS_PAYMENT_RECEIVED_MESSAGE_ID`. Content type:
Service Implicit.

```text
Dear {#var#}, we have received your payment of Rs {#var#}. Your Aquakart invoice {#var#} is ready: https://aquakart.co.in/invoice/{#var#} - AQUAKART
```

Variables: 1 name, 2 amount, 3 invoice number, 4 invoice id only (24
characters, for example `64b0f1c2a9e4d3b2c1a09f87`).

### 4. Payment link request (`paymentLinkRequest`)

Sent to the customer's mobile on the pre-invoice or quotation when staff
create or regenerate its payment link (`POST /v1/crm/pre-invoices/:id/payment-link`
or `POST /v1/crm/quotations/:id/payment-link`). A regenerated link is a new
link and is sent again; the old one stops working.

**WhatsApp**: `FAST2SMS_WHATSAPP_PAYMENT_LINK_MESSAGE_ID`

| Field    | Value                       |
| -------- | --------------------------- |
| Name     | `aquakart_payment_link`     |
| Category | Utility                     |
| Language | English                     |
| Header   | Text: `Payment request`     |
| Footer   | `Aquakart - aquakart.co.in` |
| Buttons  | None                        |

```text
Hi {{1}}, here is your secure Aquakart payment link for {{2}}.

Amount: Rs {{3}}
Pay here: {{4}}

This link is valid until {{5}}. Sign in with Google, confirm your address and pay securely through PhonePe.

For any help, please call us at 9014774667.
```

| Variable | Value sent                      | Sample                                                                   |
| -------- | ------------------------------- | ------------------------------------------------------------------------ |
| `{{1}}`  | Customer name                   | `Ravi Kumar`                                                             |
| `{{2}}`  | Pre-invoice or quotation number | `AQPI/20261120/0001`                                                     |
| `{{3}}`  | Amount                          | `29,000`                                                                 |
| `{{4}}`  | Full payment link               | `https://aquakart.co.in/pay/Q2x8vN4kT7pLm3sR9wZ1yB6cF0hJ5dG2aE8uK4iO7qX` |
| `{{5}}`  | Expiry, India time              | `23 Nov 2026, 10:30 am`                                                  |

**Sending again.** The CRM "Send" button calls
`POST /v1/crm/{pre-invoices|quotations}/:id/payment-link/send`, which sends
this same template with the same link, at most once a minute per link
([OFFLINE_PAYMENT_LINKS.md](OFFLINE_PAYMENT_LINKS.md)).

**No SMS version.** The payment token is 43 characters and a DLT variable
allows 30, so the link cannot be sent by DLT SMS. If WhatsApp fails, the CRM
still shows the URL once, for staff to share manually.

### Approval tips

- Fill every sample: an empty or unrealistic sample is the most common reason
  Meta rejects a template.
- If Meta re-categorises a template as Marketing, remove the wording it
  objects to and resubmit as Utility; Marketing templates cost more and are
  not always delivered.
- Do not change the variable order after approval without updating the code;
  the backend relies on the order, not on the wording.

## Environment

All are optional; an event without a template ID is skipped.

| Variable                                        | Meaning                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `ORDER_ALERT_PHONES`                            | Comma-separated admin mobiles. Default `9014774667`; empty disables it |
| `FAST2SMS_WHATSAPP_ADMIN_ORDER_MESSAGE_ID`      | WhatsApp template 1                                                    |
| `FAST2SMS_WHATSAPP_ORDER_CONFIRMED_MESSAGE_ID`  | WhatsApp template 2                                                    |
| `FAST2SMS_WHATSAPP_PAYMENT_RECEIVED_MESSAGE_ID` | WhatsApp template 3                                                    |
| `FAST2SMS_WHATSAPP_PAYMENT_LINK_MESSAGE_ID`     | WhatsApp template 4                                                    |
| `FAST2SMS_SMS_ADMIN_ORDER_MESSAGE_ID`           | DLT template 1 (needs `FAST2SMS_SMS_ENABLED=true` and a sender ID)     |
| `FAST2SMS_SMS_ORDER_CONFIRMED_MESSAGE_ID`       | DLT template 2                                                         |
| `FAST2SMS_SMS_PAYMENT_RECEIVED_MESSAGE_ID`      | DLT template 3                                                         |

WhatsApp also needs the existing `FAST2SMS_API_KEY` and
`FAST2SMS_WHATSAPP_PHONE_NUMBER_ID` ([FAST2SMS_WHATSAPP.md](FAST2SMS_WHATSAPP.md)).
The admin number must be able to receive WhatsApp template messages from the
business number.

## Checking delivery

Query `NotificationLog` by `event` and `reference` (order id, document number
or invoice number): `status` is `sent` or `failed`, `channel` shows WhatsApp or
SMS, and `response.errors` holds the provider error for a failure.
