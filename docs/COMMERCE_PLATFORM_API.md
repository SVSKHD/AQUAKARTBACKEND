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
  }
}
```

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
  e-commerce client moves to checkout sessions.

## Required environment values

- `ADMIN_BOOTSTRAP_KEY`
- `STANDARD_DELIVERY_CHARGE` (defaults to 50)
- `ECOM_BASE_URL` (defaults to `https://aquakart.co.in`)
- `API_BASE_URL` (defaults to `https://api.aquakart.co.in`)
- Existing `PHONEPE_MERCHANTID`, `PHONEPE_KEY`
- Optional `PHONEPE_KEY_INDEX`, `PHONEPE_BASE_URL`
