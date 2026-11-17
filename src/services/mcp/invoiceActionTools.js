import { BlogToolError } from "./errors.js";
import {
  compactText,
  isAddressMissing,
  revisionOf,
} from "./invoiceAuditRules.js";
import {
  ADDRESS_FIELD,
  DUPLICATE_RECOMMENDATION,
  actionFull,
  collectAddressCandidates,
} from "./invoiceAuditTools.js";

// Write side of the MCP invoice data-quality audit:
//   aquakart_execute_invoice_action  apply ONE approved suggestion
//   aquakart_ignore_invoice_action   dismiss a suggestion (no invoice change)
//
// The only invoice change this module can make is filling a MISSING
// customerDetails.address from evidence the scan found. Before writing it
// re-checks everything on the server:
//   - the caller's expectedRevision matches the revision the suggestion was
//     made against, and the invoice has not changed since (else `stale`)
//   - the address is still missing (else `stale`)
//   - the chosen address is still backed by the same evidence (else `stale`)
// The write is one conditional update on the invoice's updatedAt, so a
// concurrent CRM edit can never be overwritten. Totals, GST, products,
// numbers and dates are never touched. Duplicate suggestions are never
// executable: they return a manual accounting-review recommendation.
// Every execution and dismissal is idempotent (operations.js) and audited
// with the previous and new value.

const EXECUTABLE_FROM = ["pending_review", "approved", "failed"];
const IGNORABLE_FROM = ["pending_review", "approved", "failed", "stale"];

export const createInvoiceActionTools = ({
  store,
  runOperation,
  config,
  audit = async () => {},
  now = () => new Date(),
}) => {
  const lockMs = config.invoiceAudit.executionLockMs;
  const run = (ctx, tool, args, execute) =>
    runOperation(
      {
        clientId: ctx.auth.clientId,
        adminUserId: ctx.auth.adminUserId,
        tool,
        idempotencyKey: args.idempotencyKey,
        args,
        correlationId: ctx.correlationId,
      },
      execute,
    );
  const finish = (outcome) => ({
    ...outcome.result,
    operationId: outcome.operationId,
    replayed: outcome.replayed,
  });
  const by = (ctx) => String(ctx.auth.adminUserId || "");
  const load = async (actionId) => {
    const action = await store.findAction(actionId);
    if (!action)
      throw new BlogToolError(
        "INVOICE_ACTION_NOT_FOUND",
        "No suggested action with this id",
      );
    return action;
  };

  // Marks the action stale and throws ACTION_STALE: a new scan and review
  // are needed before anything can be applied.
  const stale = async (action, ctx, reason, details = {}) => {
    await store.updateAction(action.actionId, {
      $set: {
        status: "stale",
        executingUntil: null,
        lastError: { code: "ACTION_STALE", message: reason, at: now() },
      },
      $push: {
        history: { status: "stale", at: now(), by: by(ctx), note: reason },
      },
    });
    throw new BlogToolError(
      "ACTION_STALE",
      `${reason}; run aquakart_audit_invoices again and review the new suggestion`,
      details,
    );
  };

  return {
    async executeInvoiceAction(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_execute_invoice_action",
        args,
        async (operation) => {
          const action = await load(args.actionId);
          if (action.type !== "FILL_MISSING_ADDRESS") {
            throw new BlogToolError(
              "MANUAL_REVIEW_REQUIRED",
              action.type === "REVIEW_DUPLICATE_INVOICE"
                ? "Possible duplicate invoices are never changed through MCP"
                : "This suggestion has nothing to apply automatically",
              {
                type: action.type,
                recommendation:
                  action.type === "REVIEW_DUPLICATE_INVOICE"
                    ? DUPLICATE_RECOMMENDATION
                    : action.type === "REQUEST_ADDRESS"
                      ? "No reliable address is on file: ask the customer for it and update the invoice in the CRM."
                      : "The address may be incomplete: confirm it with the customer and correct it in the CRM.",
              },
            );
          }
          if (action.status === "executed")
            return {
              result: { action: actionFull(action), alreadyExecuted: true },
            };
          if (action.status === "ignored")
            throw new BlogToolError(
              "ACTION_NOT_EXECUTABLE",
              "This suggestion was dismissed",
            );
          if (action.status === "stale")
            throw new BlogToolError(
              "ACTION_STALE",
              "The invoice changed after this suggestion was made; run aquakart_audit_invoices again",
            );
          if (args.expectedRevision !== action.expectedRevision)
            throw new BlogToolError(
              "REVISION_CONFLICT",
              "expectedRevision does not match the reviewed suggestion; get it again",
              { expectedRevision: action.expectedRevision || null },
            );
          const target = args.candidateId
            ? action.candidates?.find(
                (item) => item.candidateId === args.candidateId,
              )
            : action.candidates?.find(
                (item) => item.candidateId === action.suggestedCandidateId,
              );
          if (!target)
            throw new BlogToolError(
              "CANDIDATE_REQUIRED",
              args.candidateId
                ? "candidateId is not one of this suggestion's candidates"
                : "No single address was suggested; pass the candidateId the reviewer chose",
              {
                candidateIds: (action.candidates || []).map(
                  (item) => item.candidateId,
                ),
              },
            );

          // Claim: only one execution at a time; an expired claim (crash)
          // may be taken over by a retry.
          const wasExecuting = action.status === "executing";
          const claimed = await store.claimAction(
            action.actionId,
            EXECUTABLE_FROM,
            now(),
            {
              $set: {
                status: "executing",
                executingUntil: new Date(now().getTime() + lockMs),
                "execution.operationId": operation.operationId,
                "execution.candidateId": target.candidateId,
              },
              $push: {
                history: {
                  $each: [
                    {
                      status: "approved",
                      at: now(),
                      by: by(ctx),
                      note: args.approval.note,
                    },
                    { status: "executing", at: now(), by: by(ctx) },
                  ],
                },
              },
            },
          );
          if (!claimed)
            throw Object.assign(
              new BlogToolError(
                "OPERATION_IN_PROGRESS",
                "This suggestion is being executed by another call; check it again shortly",
              ),
              { retryable: true },
            );

          const invoice = await store.findInvoice(action.invoiceId);
          if (!invoice)
            return stale(action, ctx, "The invoice no longer exists");
          const currentAddress = invoice.customerDetails?.address ?? null;
          const alreadyApplied =
            wasExecuting &&
            action.execution?.candidateId === target.candidateId &&
            compactText(currentAddress) === compactText(target.value);

          let updated = invoice;
          if (!alreadyApplied) {
            if (revisionOf(invoice) !== action.expectedRevision)
              return stale(action, ctx, "The invoice changed after the scan", {
                currentRevision: revisionOf(invoice),
              });
            if (!isAddressMissing(currentAddress))
              return stale(action, ctx, "The invoice already has an address");
            const fresh = await collectAddressCandidates(store, invoice);
            const stillBacked = fresh.ranked.candidates.find(
              (item) => item.candidateId === target.candidateId,
            );
            const suggestionMoved =
              !args.candidateId &&
              fresh.ranked.suggested?.candidateId !== target.candidateId;
            if (!stillBacked || suggestionMoved)
              return stale(
                action,
                ctx,
                "The evidence for this address changed after the scan",
              );
            try {
              updated = await store.updateInvoiceAddress(
                invoice._id,
                invoice.updatedAt ?? null,
                target.value,
              );
            } catch (error) {
              await store.updateAction(action.actionId, {
                $set: {
                  status: "failed",
                  executingUntil: null,
                  lastError: {
                    code: "STORAGE_UNAVAILABLE",
                    message: "Saving the invoice failed",
                    at: now(),
                  },
                },
                $push: {
                  history: { status: "failed", at: now(), by: by(ctx) },
                },
              });
              throw Object.assign(
                new BlogToolError(
                  "STORAGE_UNAVAILABLE",
                  "Saving the invoice failed; retry with the same idempotencyKey",
                ),
                { retryable: true },
              );
            }
            if (!updated)
              return stale(action, ctx, "The invoice changed while saving");
          }

          const before = action.currentValue ?? null;
          const done = await store.updateAction(action.actionId, {
            $set: {
              status: "executed",
              executingUntil: null,
              lastError: null,
              execution: {
                operationId: operation.operationId,
                executedBy: ctx.auth.adminUserId,
                clientId: ctx.auth.clientId,
                executedAt: now(),
                approvalNote: args.approval.note,
                candidateId: target.candidateId,
                before,
                after: target.value,
              },
            },
            $push: {
              history: {
                status: "executed",
                at: now(),
                by: by(ctx),
                note: alreadyApplied ? "recovered after interruption" : null,
              },
            },
          });
          await audit({
            action: "mcp.invoice.fill_address",
            adminUserId: ctx.auth.adminUserId,
            resourceType: "invoice",
            resourceId: String(action.invoiceId),
            before: { [ADDRESS_FIELD]: before },
            after: { [ADDRESS_FIELD]: target.value },
            metadata: {
              actionId: action.actionId,
              candidateSource: target.source,
              confidence: target.confidence,
              approvalNote: args.approval.note,
              clientId: ctx.auth.clientId,
              operationId: operation.operationId,
              correlationId: ctx.correlationId,
            },
          });
          return {
            result: {
              action: actionFull(done),
              invoice: {
                invoiceId: String(action.invoiceId),
                invoiceNo: invoice.invoiceNo || null,
                revision: revisionOf(updated),
              },
              alreadyExecuted: false,
            },
          };
        },
      );
      return finish(outcome);
    },

    async ignoreInvoiceAction(args, ctx) {
      const outcome = await run(
        ctx,
        "aquakart_ignore_invoice_action",
        args,
        async (operation) => {
          const action = await load(args.actionId);
          if (action.status === "ignored")
            return {
              result: { action: actionFull(action), alreadyIgnored: true },
            };
          if (action.status === "executed")
            throw new BlogToolError(
              "ACTION_ALREADY_EXECUTED",
              "This suggestion was already applied; correct the invoice in the CRM if needed",
            );
          const updated = await store.claimAction(
            action.actionId,
            IGNORABLE_FROM,
            now(),
            {
              $set: {
                status: "ignored",
                executingUntil: null,
                ignored: {
                  by: ctx.auth.adminUserId,
                  at: now(),
                  reason: args.reason,
                },
              },
              $push: {
                history: {
                  status: "ignored",
                  at: now(),
                  by: by(ctx),
                  note: args.reason,
                },
              },
            },
          );
          if (!updated)
            throw Object.assign(
              new BlogToolError(
                "OPERATION_IN_PROGRESS",
                "This suggestion is being executed; check it again shortly",
              ),
              { retryable: true },
            );
          await audit({
            action: "mcp.invoice.ignore_action",
            adminUserId: ctx.auth.adminUserId,
            resourceType: "invoice_action",
            resourceId: action.actionId,
            metadata: {
              invoiceId: String(action.invoiceId),
              type: action.type,
              reason: args.reason,
              clientId: ctx.auth.clientId,
              operationId: operation.operationId,
              correlationId: ctx.correlationId,
            },
          });
          return {
            result: { action: actionFull(updated), alreadyIgnored: false },
          };
        },
      );
      return finish(outcome);
    },
  };
};
