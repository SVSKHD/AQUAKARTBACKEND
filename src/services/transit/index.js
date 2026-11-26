import {
  assertInvoiceStock,
  persistInvoice,
  validateInvoicePayload,
} from "../../controllers/crm/invoice.js";
import { loadQuickCatalog } from "../../controllers/crm/aiInvoice.js";
import { loadStock } from "../aiInvoice/tools.js";
import { generateContent } from "../gemini.js";
import { deliverInvoiceWithSmsFallback } from "../invoiceSharing/invoiceDelivery.js";
import { writeAudit } from "../audit.js";
import { runtimeRouting } from "../routing/index.js";
import { createRateComparison } from "./comparison.js";
import { parseTransitText } from "./extraction.js";
import { mongoTransitStore } from "./mongoStore.js";
import { createTransitService } from "./service.js";

// Production wiring for Transit. Every dependency is an existing Aquakart
// service: the CRM invoice writer (numbering, stock), the quick-paste Gemini
// extractor, the WhatsApp/SMS invoice delivery and the audit log.

export const transit = createTransitService({
  store: mongoTransitStore,
  invoiceWriter: {
    validate: (payload) => validateInvoicePayload(payload),
    // Transit sends the invoice itself so it can record the outcome.
    persist: (payload) => persistInvoice(payload, { autoDeliver: false }),
    assertStock: (products) => assertInvoiceStock(products),
  },
  routing: runtimeRouting,
  parse: (source) =>
    parseTransitText(source, {
      generate: generateContent,
      loadCatalog: loadQuickCatalog,
      loadStock,
    }),
  notifier: {
    deliverInvoice: ({ invoice, dedupePrefix }) =>
      deliverInvoiceWithSmsFallback({
        invoice,
        trigger: "transit",
        dedupePrefix,
      }),
  },
  comparison: createRateComparison(),
  audit: ({ actor, action, resourceType, resourceId, metadata }) =>
    writeAudit({
      req: { user: { _id: actor?.id } },
      action,
      resourceType,
      resourceId,
      metadata,
    }),
});
