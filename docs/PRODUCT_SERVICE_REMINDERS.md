# Product regeneration and service reminders

The daily job uses the invoice purchase date as its schedule anchor.

## Default product schedules

| Product name | Regeneration |
| --- | --- |
| Auto 25 | Every calendar month |
| Auto 40 | Every calendar month |
| Auto 100L | Every calendar month |
| Auto Sand Filter | Every calendar month |
| Bathroom Water Softener | Every 7 days |

Every invoice product also receives an annual service reminder unless its
product record sets `reminderPolicy.annualService` to `false`.

Every product has a 12-month warranty calculated from the invoice purchase
date. A WhatsApp warning is sent 30 days before warranty expiry.

Product records can override name-based defaults with:

```json
{
  "reminderPolicy": {
    "regeneration": {
      "enabled": true,
      "intervalUnit": "month",
      "intervalValue": 1
    },
    "annualService": true
  }
}
```

## Environment variables

```text
PRODUCT_SERVICE_REMINDERS_ENABLED=true
PRODUCT_SERVICE_REMINDERS_HOUR_IST=9
FAST2SMS_WHATSAPP_REGENERATION_MESSAGE_ID=
FAST2SMS_WHATSAPP_ANNUAL_SERVICE_MESSAGE_ID=
FAST2SMS_WHATSAPP_WARRANTY_EXPIRY_MESSAGE_ID=
```

Approved Fast2SMS WhatsApp template IDs:

- Regeneration: `31043`
- Annual service: `31044`
- Warranty expiry: `31045`

The environment variables are optional overrides for these IDs.

- Regeneration: `Hello {#var#}, your {#var#} regeneration is due today. Please complete the regeneration to maintain water quality and product performance. - Aquakart`
- Annual service: `Hello {#var#}, the annual service for your {#var#} is due. Please contact Aquakart to schedule your service visit. - Aquakart`

Regeneration and service templates receive customer name, product name, due
date and invoice link. The warranty template receives customer name, product
name, purchase date, warranty expiry date and invoice link. A unique
invoice/product/type/due-date key prevents duplicates; failed WhatsApp
deliveries can be retried on the next job run within the grace window.
