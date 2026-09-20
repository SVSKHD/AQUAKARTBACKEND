export const buildInvoiceAutomationEligibilityFilter = () => ({
  $or: [
    { migrated: { $ne: true } },
    { migrated: true, migrationReviewed: true },
  ],
});

export const isInvoiceAutomationEligible = (invoice = {}) =>
  invoice?.migrated !== true || invoice?.migrationReviewed === true;
