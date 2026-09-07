# Public monthly invoice Excel reports

The CRM page `/invoices/report/:month` defaults to **2026**, independent of the current year. `/invoices/report/:month/:year` selects an explicit year. Months accept 1–12, 01–12, or full English names, case insensitive.

The page calls `GET /v1/invoices/report/:month/:year` (year also optional). It downloads `Aquakart_Invoices_YYYY-MM.xlsx`, with Invoices and Products sheets matching the CRM bulk export. Invalid periods return 400, empty months 404, and generation failures 500.

Both routes are deliberately public, without authentication or expiring tokens, as requested. Anyone knowing or changing the month/year can download the associated invoices, including customer contact information. There is no dashboard access. Responses disable caching and request no indexing; these headers are not access controls. The route allows 20 requests per minute per IP.

Invoice `date` is matched as YYYY-MM-DD. Only records without that field use `createdAt`, bounded by the selected calendar month in Asia/Kolkata. All invoice types/payment statuses are included, consistent with an unfiltered CRM export.

Calculations preserve existing CRM behavior: sum productPrice without multiplying by quantity; base is floor(total * 0.8474594), GST is floor(base * 0.18). The schema has no stored tax breakdown. These are legacy export calculations, not a new tax calculation or filing format; review tax/quantity semantics separately. Monetary cells display two decimals to preserve existing fractional amounts.

Deploy backend first, then AQUACRM25DEV. The admin web server must serve index.html for nested SPA routes (the existing `serve -s dist` start command supports this). No environment variables or recipient configuration are required for downloads. Scheduled WhatsApp delivery is separate from this route change.

Examples:
- https://admin.aquakart.co.in/invoices/report/august
- https://admin.aquakart.co.in/invoices/report/8/2025

Validation: `node --test test/invoiceReports.test.js test/invoiceReportRoute.test.js`.
