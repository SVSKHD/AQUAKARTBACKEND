# Fast2SMS WhatsApp integration

The backend sends approved WhatsApp templates through Fast2SMS. The API key is
kept on the server and must not be sent to the CRM or browser.

## Configuration

- `FAST2SMS_API_KEY`: API Authorization key from Fast2SMS.
- `FAST2SMS_WHATSAPP_PHONE_NUMBER_ID`: connected WABA phone-number ID.
- `FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID`: approved invoice template message ID.
- `FAST2SMS_BASE_URL`: optional; defaults to `https://www.fast2sms.com`.

The backend also accepts these migration aliases, but new Jenkins deployments
should use the canonical names above:

- `FAST2SMS_AUTHORIZATION_KEY` for `FAST2SMS_API_KEY`
- `FAST2SMS_PHONE_NUMBER_ID` for `FAST2SMS_WHATSAPP_PHONE_NUMBER_ID`
- `FAST2SMS_WHATSAPP_MESSAGE_ID` for `FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID`

If configuration is incomplete, CRM invoice delivery returns the exact missing
variable names. SMS fallback is attempted only when the SMS provider is fully
configured, so a disabled SMS fallback cannot hide the original WhatsApp error.

The invoice template variables are sent in this order:

1. customer name
2. invoice number
3. secure customer invoice URL

If the CRM supplies a public HTTPS `pdfUrl`, it is passed as the template header
media and receives an `AquaKart-Invoice-<number>.pdf` document filename. The
Fast2SMS template therefore needs a PDF document header when attachments are
required.

## CRM endpoints

- `GET /v1/notify/status` checks configuration without exposing secrets.
- `GET /v1/notify/whatsapp/templates` retrieves WABA/template details for an admin.
- `POST /v1/crm/notify/invoice/:id` sends the configured invoice template.
- `POST /v1/notify/send-whatsapp` sends another approved template by `messageId`.

If WhatsApp delivery fails, invoice delivery falls back to the configured
Fast2SMS DLT SMS template. Configure `FAST2SMS_SMS_ENABLED=true`,
`FAST2SMS_SMS_SENDER_ID`, and `FAST2SMS_SMS_INVOICE_MESSAGE_ID` after the DLT
template is approved. Variables use the same order as the WhatsApp template.

At 08:00 Asia/Kolkata, the backend retries invoices that are not yet linked to a
verified customer (`firebaseUid` is empty). A per-invoice, per-day dedupe key
prevents duplicate sends after restarts. Set `INVOICE_REMINDER_ENABLED=false`
to pause the job.
