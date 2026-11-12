# Aquakart commerce platform API

This document is the shared contract for `AQUAKARTECOM`, `AQUACRM25DEV`, and
`AQUAKARTBACKEND`. All monetary values returned by checkout are authoritative.
Clients must never submit product prices, discount amounts, payable totals, or
payment status.

## Customer API

| Method | Path                           | Purpose                                                      |
| ------ | ------------------------------ | ------------------------------------------------------------ |
| POST   | `/v1/checkout/quote`           | Validate cart/coupon and create a 15-minute checkout session |
| POST   | `/v1/checkout/orders/cod`      | Create COD order from a checkout session                     |
| GET    | `/v1/checkout/payment-methods` | List enabled payment methods                                 |
| POST   | `/v1/payments`                 | Create a gateway payment from a checkout session             |
| GET    | `/v1/payments/:id`             | Read the authenticated customer's payment state              |
| GET    | `/v1/referrals/me`             | Read/create the customer's referral account                  |
| POST   | `/v1/referrals/attribute`      | Attribute the authenticated account to a referral code       |

### Checkout quote request

```json
{
  "cart": [{ "productId": "mongo-product-id", "quantity": 2 }],
  "couponCode": "AQUA-WELCOME"
}
```

The response contains `data.id`, the checkout session ID, and the authoritative
`subtotal`, `discount`, `deliveryCharge`, `tax`, and `payableAmount`.

### Payment request

Send a unique `Idempotency-Key` header.

```json
{
  "checkoutSessionId": "mongo-checkout-session-id",
  "gateway": "phonepe",
  "shippingAddress": {
    "street": "...",
    "city": "...",
    "state": "...",
    "postalCode": "..."
  },
  "installation": { "day": "2026-10-30", "slot": "12 pm – 3 pm" }
}
```

`installation` is optional on both `POST /v1/payments` and
`POST /v1/checkout/orders/cod`. It is saved on the order as `installation.day`
(`YYYY-MM-DD`) and `installation.slot` (up to 40 characters). A missing or
malformed value is dropped and never blocks the order. The team confirms the
slot by phone.

## CRM API

| Area               | Endpoints                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Permissions        | `GET /v1/admin/permissions`                                                                 |
| Roles              | `GET/POST /v1/admin/roles`, `PATCH/DELETE /v1/admin/roles/:id`                              |
| Staff              | `GET/POST /v1/admin/staff`, `PATCH /v1/admin/staff/:id`, `PATCH /v1/admin/staff/:id/status` |
| Audit              | `GET /v1/admin/audit-logs`                                                                  |
| Coupons            | `GET/POST /v1/admin/coupons`, `GET/PATCH/DELETE /v1/admin/coupons/:id`                      |
| Redemptions        | `GET /v1/admin/coupons/:id/redemptions`                                                     |
| Referral campaigns | `GET/POST /v1/admin/campaigns`, `PATCH /v1/admin/campaigns/:id`                             |
| Referrals          | `GET /v1/admin/referrals`                                                                   |
| Rewards            | `GET /v1/admin/rewards`, `PATCH /v1/admin/rewards/:id/status`                               |
| Payments           | `GET /v1/admin/payments`, `POST /v1/admin/payments/:id/reconcile`                           |
| Gateways           | `GET /v1/admin/payment-gateways`, `PUT /v1/admin/payment-gateways/:key`                     |

## Authentication and migration

- Existing numeric role-1 administrators retain access during migration.
- New staff use a role reference and named permissions.
- Public admin signup works only for the first administrator. Later bootstrap
  requests require `X-Admin-Bootstrap-Key` matching `ADMIN_BOOTSTRAP_KEY`.
- Legacy coupon URLs remain available but now use permission enforcement.
- Legacy storefront order/payment URLs remain temporarily available until the
  e-commerce client moves to checkout sessions. Since 2026-11-12 they are
  locked down:
  - `POST /v1/order/cod` and `POST /v1/order/pay` require a customer login.
    The user comes from the token, and a different `user` in the body gets
    a 403. Prices, delivery charge and total are computed on the server from
    `items[].productId` / `quantity` (same pricing as `/v1/checkout`), and
    status fields in the body are ignored.
  - Coupons are not applied on these routes; use `/v1/checkout`.
  - `/order/pay` needs a `transactionId` of 6–38 letters, digits, `_` or
    `-` that no other order uses (409 otherwise). PhonePe is charged the
    server total.
  - `GET /v1/order/:id`: the owning customer or an admin. Other customers
    get 404.
  - `GET /v1/orders/user/:id` and `GET /v1/order/transaction-id/:id` return
    only the caller's own orders.
  - `PUT /v1/order/user/:id` (customer): own order only, while it is
    Pending or Processing (409 after). Only cancelling (`orderStatus:
"Cancelled"` or `orderCancelled: true`), `shippingAddress`,
    `installation` and `notes` can change. Payment, total, refund, invoice
    and item fields are ignored.
  - `PUT /v1/admin/order/:id` is unchanged (admin).
  - `POST /v1/phonepe-verify/:id` stays public (PhonePe's callback) and
    re-checks the status with PhonePe.
    - An order is marked Paid only when the amount PhonePe collected equals
      the order total. A mismatch is left as Processing and logged.
    - Pending stays Pending (it was marked Failed before).
    - A Paid order is never downgraded or re-notified, and the confirmation
      is sent once, only on Paid.

## Required environment values

- `ADMIN_BOOTSTRAP_KEY`
- `STANDARD_DELIVERY_CHARGE` (defaults to 50)
- `ECOM_BASE_URL` (defaults to `https://aquakart.co.in`)
- `API_BASE_URL` (defaults to `https://api.aquakart.co.in`)
- Existing `PHONEPE_MERCHANTID`, `PHONEPE_KEY`
- Optional `PHONEPE_KEY_INDEX`, `PHONEPE_BASE_URL`
