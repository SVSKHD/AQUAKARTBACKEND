# Fast2SMS WhatsApp integration

The backend sends approved WhatsApp templates through Fast2SMS. The API key is
kept on the server and must not be sent to the CRM or browser.

## Configuration

- `FAST2SMS_API_KEY`: API Authorization key from Fast2SMS.
- `FAST2SMS_WHATSAPP_PHONE_NUMBER_ID`: connected WABA phone-number ID.
- `FAST2SMS_WHATSAPP_INVOICE_MESSAGE_ID`: approved invoice template message ID.
- `FAST2SMS_BASE_URL`: optional; defaults to `https://www.fast2sms.com`.

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

SMS is deliberately represented only by a disabled provider contract. It does
not send until the SMS templates, DLT registration, and product flow are agreed.
