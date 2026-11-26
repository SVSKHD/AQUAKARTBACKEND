# Transit V1

Transporters record a delivery from free text, get a road-distance transport
charge from the warehouse, create the customer invoice, record what the
customer paid, and see their payout status. Admins manage pricing, the
warehouse, rate benchmarks, verification, corrections, settlement and
reports. Mounted at `/v1/crm/transit` (staff JWT, `Authorization: Bearer`).

## Flow

1. `POST /parse` reads the text with Gemini (the CRM quick-paste extractor) and
   matches products against the catalog in code. It returns structured fields
   with a status per field, `corrections` (blocking) and `warnings`. Gemini
   never sets a price that isn't in the text, a phone number that isn't in the
   text, a product id outside the catalog, a transport charge or a payment
   status (payment fields it reads are dropped).
2. The transporter fixes what `corrections` lists and calls `POST /preview`
   with the confirmed details. The backend checks the products against the
   catalog, geocodes the address (or uses a pinned `destination`), asks the
   routing provider for the **road** distance from the active warehouse, and
   prices it from the rate card in force. Nothing is written.
3. `POST /transits` with an `Idempotency-Key` header repeats the same
   computation, stores the transit with its route and price snapshots, creates
   the invoice through the CRM invoice service (`persistInvoice`: numbering,
   stock), links it to the storefront account with the same phone (if any),
   and sends it on WhatsApp (SMS fallback) through the existing delivery
   service.
4. Collections (`POST /transits/:id/collections`) record what the customer
   paid. Admins verify reported UPI/card/bank payments, approve exceptions,
   settle payouts and read reports.

If the address can't be placed precisely (a locality, a pincode, several
places), the response is `422 DESTINATION_AMBIGUOUS` with `details.candidates`;
the transporter pins the location and sends `destination: { lat, lng }`.
Routing failures block submission; no distance is ever guessed.

## Pricing (MongoDB, admin-editable)

`AquaTransitRateCard`: `tiers [{ minKm, maxKm|null, price }]`,
`cashIncentive`, `effectiveFrom`, `effectiveTo`, `status`, `createdBy`,
`updatedBy`, `history`. Tiers must start at 0, follow each other without gaps
or overlaps, and end with one open tier. A tier covers `(minKm, maxKm]` (the
first also covers 0), with distance rounded to 0.01 km:

| Distance         | V1 price |
| ---------------- | -------: |
| 0 – 10.00 km     |     ₹350 |
| 10.01 – 15.00 km |     ₹400 |
| above 15.00 km   |     ₹500 |

The card in force is the active card with the latest `effectiveFrom` that has
started and not ended. Prices are never edited in place: `POST /pricing`
creates a new card that takes over at its `effectiveFrom`; `PATCH /pricing/:id`
only renames, ends (`effectiveTo`) or deactivates a card. Every transit keeps a
snapshot of the card, tier and price it used. Initial card:
`npm run transit:seed-pricing` (dry run), then `-- --apply`. It writes only
when no card exists.

## Money

- `payout.totalPayable = payout.baseCharge + payout.cashIncentive`.
- Cash incentive (from the rate card snapshot, V1 ₹100) is added once per
  transit when the **delivering transporter** records a `cash` collection,
  while the payout is unsettled. UPI/card/bank, cash recorded by an admin, and
  collections after settlement don't qualify. Repeating a collection with the
  same `collectionKey` is a no-op.
- Customer payment: `cash` counts as confirmed at once; `upi`, `card`,
  `bank_transfer` are `transporter_reported` (need a reference) and only count
  after an admin verifies them (`.../review`). The status is `paid` only when
  confirmed amounts cover the invoice total, or an admin approves an exception
  with a reason. Collections above the amount still due are refused. The
  invoice's existing `paidStatus` follows (`unpaid` / `partial` / `paid`).
- Settlement: every transit starts `UNSETTLED`. Only `transit.settle` can
  settle, never their own payouts, in batches of up to 200 with a payment
  reference and an `Idempotency-Key`. One conditional `updateMany` settles each
  transit exactly once even when two admins run batches at the same time; the
  batch records what was settled and why others were skipped.
- Transport cost never changes invoice revenue or taxable amounts. Reports show
  `contributionAfterTransport = revenue - transportPayable` (product cost not
  included).

## Snapshots and corrections

The transit's `delivery` (address, warehouse and destination coordinates,
distance, provider, polyline) and `pricing` are immutable: the model refuses
any update touching them unless it is a correction. The invoice keeps a copy in
`transitDelivery` plus `sourceTransitId` (unique); invoice create/update routes
drop both fields, so the CRM edit form can't change them. An admin correction
(`POST /transits/:id/corrections` with a reason and a new pin or address)
re-routes from the **original** warehouse, re-prices with the original rate
card, stores before/after in `corrections[]` and the audit log, and updates the
invoice copy. Settled transits can't be corrected or cancelled.

## Invoice sending

`invoiceDelivery.status`: `pending` → `sending` → `accepted` | `failed`.
`accepted` means the messaging provider accepted the message; there is no
handset delivery receipt, so it is never called delivered. A failure keeps the
invoice; `POST /transits/:id/invoice-delivery/retry` sends again with a new
dedupe key per attempt (the notification log refuses to repeat a key).

## Idempotency

- Submission: unique `(transporterId, idempotencyKey)`. The same key returns
  the same transit (`200`, `replayed: true`); the same key with different
  details is `409 IDEMPOTENCY_KEY_REUSED`; a parallel request gets
  `409 SUBMISSION_IN_PROGRESS`.
- One invoice per transit: unique partial index on `invoice.sourceTransitId`.
  A retry after a crash finds the invoice already written instead of creating
  another; stock is rolled back by `persistInvoice` on a duplicate.
- Stock is checked before the transit is created. If the invoice still fails,
  the transit becomes `failed` and the same key can retry it.

## Permissions

| Permission        | Grants                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `transit.operate` | parse, preview, submit; own transits; record collections; retry sending; own payout summary |
| `transit.read`    | every transit, settlements list, reports, pricing and benchmark lists                       |
| `transit.manage`  | warehouse, rate cards, benchmarks, verify collections, exceptions, corrections, cancel      |
| `transit.settle`  | settlement batches                                                                          |

Create a **Transporter** role with only `transit.operate` (CRM → access
control) and create the transporter's staff account with it. Staff accounts
created through the CRM get `role: 3`, so they can't use `checkAdmin` routes
(invoice edit, etc.). Another transporter's transit answers `404`.

## Endpoints

| Method | Path                                                                               | Permission              |
| ------ | ---------------------------------------------------------------------------------- | ----------------------- |
| POST   | `/parse`                                                                           | operate                 |
| POST   | `/preview`                                                                         | operate                 |
| POST   | `/transits` (`Idempotency-Key`)                                                    | operate                 |
| GET    | `/transits?page&limit&status&settlementStatus&paymentStatus&from&to&transporterId` | operate or read         |
| GET    | `/transits/:id`                                                                    | operate or read         |
| POST   | `/transits/:id/collections`                                                        | operate or manage       |
| POST   | `/transits/:id/invoice-delivery/retry`                                             | operate or manage       |
| GET    | `/payouts/mine`                                                                    | operate                 |
| GET    | `/warehouse` · PUT `/warehouse`                                                    | operate/read · manage   |
| GET    | `/pricing` · POST `/pricing` · PATCH `/pricing/:id`                                | read · manage           |
| GET    | `/benchmarks` · POST · PATCH `/benchmarks/:id`                                     | read · manage           |
| GET    | `/comparisons?transitId` or `?distanceKm&durationMinutes`                          | read or manage          |
| POST   | `/transits/:id/collections/:collectionId/review`                                   | manage                  |
| POST   | `/transits/:id/payment-exception`                                                  | manage                  |
| POST   | `/transits/:id/corrections`                                                        | manage                  |
| POST   | `/transits/:id/cancel`                                                             | manage                  |
| POST   | `/settlements` (`Idempotency-Key`) · GET `/settlements`                            | settle · read or settle |
| GET    | `/reports/summary?from&to&transporterId`                                           | read                    |

Responses are `{ success: true, data }`; errors are
`{ success: false, code, message, details? }`. Lists return
`{ items, page, limit, total, totalPages }` (limit up to 100). Parse, preview,
submit, comparisons and corrections are rate-limited to 20 per minute per staff
account (they call Gemini or the routing provider).

### Examples

```http
POST /v1/crm/transit/parse
{ "text": "Ramesh, Tellapur near school, automatic softener 8L, 18500, phone 9XXXXXXXXX" }

200 { "success": true, "data": {
  "customer": { "name": { "value": "Ramesh", "status": "extracted" },
                "phone": { "value": "", "status": "unreadable" },
                "address": { "value": "Tellapur near school", "status": "extracted" }, ... },
  "items": [{ "line": 1, "rawName": "automatic softener 8L", "productId": "…",
              "productName": "Automatic Softener 8L", "unitPrice": 18500,
              "quantity": 1, "quantityAssumed": true, "matchConfidence": "high" }],
  "corrections": [{ "field": "customer.phone", "code": "PHONE_UNREADABLE",
                    "message": "The phone number is incomplete or masked; …" }],
  "warnings": [...], "ready": false } }
```

```http
POST /v1/crm/transit/transits
Idempotency-Key: 7f6c2a1e-delivery-0001
{ "customer": { "name": "Ramesh", "phone": "9876543210",
                "address": "Plot 12, near ZPHS school, Tellapur 502032" },
  "items": [{ "productId": "…", "quantity": 1, "unitPrice": 18500 }],
  "destination": { "lat": 17.4612, "lng": 78.2841 },
  "expectedTransportCharge": 400 }

201 { "success": true, "data": { "replayed": false, "transit": {
  "id": "…", "status": "invoiced", "invoiceNo": "AQB…",
  "delivery": { "distanceKm": 12.4, "destination": { "lat": 17.4612, "lng": 78.2841, "source": "pinned" },
                "warehouse": { "name": "…", "lat": …, "lng": … }, "provider": "osm" },
  "pricing": { "baseCharge": 400, "cashIncentive": 100, "tier": { "minKm": 10, "maxKm": 15, "price": 400 } },
  "payout": { "baseCharge": 400, "cashIncentive": 0, "totalPayable": 400, "settlementStatus": "UNSETTLED" },
  "customerPayment": { "status": "unpaid", "amountDue": 18500, "balance": 18500 },
  "invoiceDelivery": { "status": "accepted", "attempts": 1, "channel": "whatsapp" } } } }
```

```http
POST /v1/crm/transit/transits/:id/collections
{ "amount": 18500, "method": "cash", "collectionKey": "c-7f6c2a1e-0001" }
201 { "success": true, "data": { "incentiveAwarded": true, "duplicate": false,
      "transit": { "payout": { "cashIncentive": 100, "totalPayable": 500 }, "customerPayment": { "status": "paid" } } } }

POST /v1/crm/transit/settlements
Idempotency-Key: settle-2026-11-30
{ "transitIds": ["…", "…"], "paymentReference": "NEFT/UTR 1234", "note": "Week 48" }
201 { "success": true, "data": { "replayed": false, "batch": {
      "totals": { "count": 2, "baseCharge": 750, "cashIncentive": 100, "totalPayable": 850 },
      "skipped": [] } } }
```

## Rate comparison

`GET /comparisons` returns rows labelled `internal` (the rate card),
`manual_benchmark` (computed from admin-entered Porter/Rapido fares with
`observedAt` and `sourceNote`) and `live_quote`. No official Porter or Rapido
quote API is integrated, so live quotes are listed as unavailable. The
comparison is informational and never changes the charge.

## Setup and rollout

1. Routing. The default provider `osm` needs no key or account: OpenStreetMap
   Nominatim for addresses and OSRM (`routing.openstreetmap.de`, car profile)
   for road distance. Both are volunteer-run public servers with fair-use
   policies and no uptime guarantee: Nominatim takes at most one request per
   second (queued in-process) with an identifying `User-Agent`
   (`TRANSIT_OSM_USER_AGENT`). If volume grows, self-host them and set
   `TRANSIT_NOMINATIM_URL` / `TRANSIT_OSRM_URL`. OSM address coverage in
   Telangana villages is thin, so expect most deliveries to be **pinned**
   (`422 DESTINATION_AMBIGUOUS` / `DESTINATION_NOT_FOUND` → pin) rather than
   geocoded. A pin further than 500 m from a mapped road is refused
   (`ROUTE_NOT_FOUND`), because OSRM would leave that stretch out of the
   distance. To use Google instead, set `TRANSIT_ROUTING_PROVIDER=google` and
   `GOOGLE_MAPS_API_KEY` (Geocoding API + Routes API).
2. Set the warehouse: `PUT /warehouse { name, address, lat, lng }`.
3. Seed or create the rate card.
4. Create the Transporter role and accounts.

Rollback: remove the `/v1/crm/transit` mount in `app.js` (or revoke the
permissions). New collections (`aquatransits`, `aquatransitwarehouses`,
`aquatransitratecards`, `aquatransportbenchmarks`,
`aquatransitsettlementbatches`) can stay; invoices created by Transit are
normal invoices with two extra optional fields. The new invoice index is a
partial unique index on `sourceTransitId` (existing invoices don't have the
field, so it builds without conflicts).
