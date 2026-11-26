import { buildQuickDraft } from "../aiInvoice/quickDraft.js";

// Transporter raw text -> structured, reviewable details. Reuses the CRM
// quick-paste extractor (one Gemini call, catalog matching in code, numbers
// checked against the text so nothing is invented). On top of it:
// - payment status / method read by Gemini are dropped: payment is recorded
//   later as a collection, never decided by AI;
// - name, phone, delivery address, a catalog product and a price are all
//   required; anything missing or uncertain becomes a correction request.
// Nothing is written. The transporter submits the confirmed details.

export const PARSE_MAX_CHARS = 2000;

const field = (value, { rejected = false } = {}) => ({
  value,
  status: value ? "extracted" : rejected ? "unreadable" : "missing",
});

export const parseTransitText = async (source, deps) => {
  const draft = await buildQuickDraft(source, deps);
  const { customer } = draft;
  const corrections = [];
  const warnings = (draft.validation?.warnings || []).map((w) => ({
    field: w.field,
    message: w.message,
  }));
  const need = (fieldName, code, message) =>
    corrections.push({ field: fieldName, code, message });

  const phoneUnreadable = (draft.notes || []).some((note) =>
    /phone number could not be read/i.test(note),
  );
  if (!customer.name)
    need(
      "customer.name",
      "NAME_MISSING",
      "Customer name was not found in the text",
    );
  if (!customer.phone)
    need(
      "customer.phone",
      phoneUnreadable ? "PHONE_UNREADABLE" : "PHONE_MISSING",
      phoneUnreadable
        ? "The phone number is incomplete or masked; type the full 10-digit number"
        : "Customer phone number was not found in the text",
    );
  if (!customer.address)
    need(
      "customer.address",
      "ADDRESS_MISSING",
      "Delivery address was not found in the text",
    );

  if (!draft.items.length)
    need("items", "PRODUCT_MISSING", "No product was found in the text");
  const items = draft.items.map((item) => {
    const fieldName = `items.${item.line}`;
    if (!item.match)
      need(
        `${fieldName}.productId`,
        "PRODUCT_NOT_MATCHED",
        `"${item.rawName}" does not match a catalog product; choose one`,
      );
    else if (item.confidence === "low")
      need(
        `${fieldName}.productId`,
        "PRODUCT_AMBIGUOUS",
        `"${item.rawName}" matches several products; choose the right one`,
      );
    else if (item.confidence === "ai")
      warnings.push({
        field: `${fieldName}.productId`,
        message: `"${item.rawName}" was matched to ${item.match.name}; check it`,
      });
    if (item.priceMissing)
      need(
        `${fieldName}.unitPrice`,
        "PRICE_MISSING",
        `No selling price was written for "${item.rawName}"`,
      );
    if (item.quantityAssumed)
      warnings.push({
        field: `${fieldName}.quantity`,
        message: `No quantity written for "${item.rawName}"; 1 assumed`,
      });
    return {
      line: item.line,
      rawName: item.rawName,
      productId: item.match?.productId || null,
      productName: item.match?.name || null,
      catalogPrice: item.match?.catalogPrice ?? null,
      quantity: item.quantity,
      quantityAssumed: item.quantityAssumed,
      unitPrice: item.unitPrice,
      // high: clear code match; ai: Gemini chose among code candidates;
      // low: several equally good matches; none: no match.
      matchConfidence: item.match ? item.confidence : "none",
      alternatives: item.alternatives || [],
      serialNo: item.serialNo || "",
    };
  });

  return {
    customer: {
      name: field(customer.name),
      phone: field(customer.phone, { rejected: phoneUnreadable }),
      email: field(customer.email),
      address: field(customer.address),
    },
    items,
    corrections,
    warnings,
    notes: (draft.notes || []).filter(
      (note) => !/phone number could not be read/i.test(note),
    ),
    // Ready means the details can go to preview; route and price come next.
    ready: corrections.length === 0,
  };
};
