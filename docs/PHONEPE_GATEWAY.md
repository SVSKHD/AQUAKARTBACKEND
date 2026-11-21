# PhonePe gateway (v1 and v2)

Every online payment goes through `src/services/gateways/phonepe.js`:

| Caller                     | Route                                  | Code                                |
| -------------------------- | -------------------------------------- | ----------------------------------- |
| Storefront checkout        | `POST /v1/payments`                    | `src/controllers/payments.js`       |
| Legacy `/checkout` page    | `POST /v1/order/pay`                   | `src/controllers/phonepeGateway.js` |
| CRM payment links (`/pay`) | `POST /v1/payments/offline/:token/...` | `src/services/offlinePayments/`     |

`PHONEPE_API_VERSION` picks the PhonePe API for all of them at once:

- `v1` (default, or unset): `/pg/v1/pay` and `/pg/v1/status`, signed with
  the salt key (`X-VERIFY`). PhonePe has deprecated this flow and no longer
  issues v1 keys.
- `v2`: Standard Checkout. An OAuth token from the client credentials, then
  `POST /checkout/v2/pay` and `GET /checkout/v2/order/{merchantOrderId}/status`
  with `Authorization: O-Bearer <token>`.

The callers don't change between versions: `createPhonePePayment` returns
`{ redirectUrl, transactionId, raw }` and `verifyPhonePePayment` returns
`{ status: paid|pending|failed, amount (rupees), code, errorCode, merchantId,
merchantTransactionId, gatewayTransactionId, paymentInstrumentType,
instrument, raw }`. Our own order / link id is PhonePe's `merchantOrderId`
(v2) or `merchantTransactionId` (v1). All existing checks (amount, merchant,
transaction, never downgrading a paid order, one invoice per link) are the
same for both.

## Environment

| Variable                                                               | Version | Notes                                                                                 |
| ---------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `PHONEPE_API_VERSION`                                                  | both    | `v2` to switch; anything else is v1                                                   |
| `PHONEPE_MERCHANTID`                                                   | both    | Required for v2 too: payment links compare it with every verified payment             |
| `PHONEPE_KEY`, `PHONEPE_KEY_INDEX`, `PHONEPE_BASE_URL`                 | v1      | Salt key, its index (default 1), host (default `https://api.phonepe.com/apis/hermes`) |
| `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION` | v2      | From PhonePe (Business Dashboard / Integration Team); secrets, never logged           |
| `PHONEPE_ENV`                                                          | v2      | `sandbox` uses `api-preprod.phonepe.com/apis/pg-sandbox`; otherwise production        |
| `PHONEPE_AUTH_URL`, `PHONEPE_V2_BASE_URL`                              | v2      | Optional host overrides                                                               |
| `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`                 | v2      | The username/password set on the dashboard webhook (SHA auth)                         |

Production v2 hosts: token
`https://api.phonepe.com/apis/identity-manager/v1/oauth/token`, checkout
`https://api.phonepe.com/apis/pg`.

## v2 details

- **Token**: `POST .../v1/oauth/token`, form body `client_id`,
  `client_version`, `client_secret`, `grant_type=client_credentials`. One
  token per process, renewed 5 minutes before `expires_at`; a 401 from a
  checkout call drops it and retries once.
- **Pay**: `merchantOrderId` (our id, letters/digits/`_`/`-`, max 63),
  `amount` in paise, `paymentFlow: { type: "PG_CHECKOUT", merchantUrls: {
redirectUrl } }`, `metaInfo.udf1` = our user id. Payment links also send
  `expireAfter` = the attempt lifetime (`OFFLINE_PAYMENT_ATTEMPT_TTL_MINUTES`,
  clamped to 300-3600 s). No mobile number is sent in v2.
- **Status**: `state` `COMPLETED` → paid, `FAILED` → failed, anything else →
  pending. The payment method is the completed attempt's `paymentMode`
  (`UPI_INTENT`, `UPI_COLLECT`, `UPI_QR`, `CARD`, `NET_BANKING`); `errorCode`
  (for example `INVALID_MPIN`) is kept for failed orders. An order PhonePe
  never created (`INVALID_MERCHANT_ORDER_ID`) counts as failed.

## Webhooks

- **v1**: PhonePe calls the `callbackUrl` sent with each payment:
  `POST /v1/webhooks/payments/phonepe/:transactionId` (checkout and payment
  links) or `POST /v1/phonepe-verify/:id` (legacy `/checkout`).
- **v2**: one webhook for everything, created on the PhonePe Business
  Dashboard (Developer Settings → Webhook → Create Webhook; Test Mode off for
  production):
  - URL: `https://api.aquakart.co.in/v1/webhooks/payments/phonepe`
  - Authentication: SHA, with a username and password; set the same values in
    `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD`. A request whose
    `Authorization` doesn't match SHA256(`username:password`) gets 401.
    Without these two settings the webhook still works (with a warning in the
    log), because the outcome is never taken from the request (below).
  - Events: `checkout.order.completed`, `checkout.order.failed`.
  - The body is only used for `payload.merchantOrderId`; the outcome always
    comes from the status API with our token. It settles the matching payment
    attempt (checkout or payment link), else the legacy order with that
    `transactionId`, else answers 200 `{ ignored: true }`.
- Customers returning from PhonePe are also checked from the status API (the
  `/order/{id}` and `/pay/{token}` pages), so a missed webhook only delays the
  update.

## Switching to v2

1. Get v2 credentials from PhonePe (Client ID, Client Secret, Client Version).
2. In the CRM environment settings (or the server environment) set
   `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION` and
   check `PHONEPE_MERCHANTID`. Optionally test first with `PHONEPE_ENV=sandbox`
   and sandbox credentials.
3. Create the dashboard webhook above and set
   `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD`.
4. Set `PHONEPE_API_VERSION=v2` and restart the backend.
5. Make one small real payment by UPI and one by card, and check the order or
   payment link shows Paid.

To go back, remove `PHONEPE_API_VERSION` (or set `v1`) and restart. Payments
started under one version must be verified with the same version: switch when
no payment is in progress, or reconcile leftovers after switching back.

## Not covered

`POST /v1/crm/phonepe/payment-link` (`src/controllers/crm/paymentLink.js`,
PhonePe's old `/v3/payLink/init`) is a separate, older PhonePe product and is
still v1 only. The CRM's current payment links use `/v1/payments/offline`.

Tests: `test/phonepeGateway.test.js` (both versions, token, webhook),
`test/legacyOrders.test.js`, `test/offlinePayments.test.js`.
