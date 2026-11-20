import crypto from "node:crypto";
import { normalizeIndianPhone } from "../../utils/invoiceAccess.js";
import {
  LINK_UNAVAILABLE,
  OfflinePaymentError,
  createLinkToken,
  formatAddress,
  hashLinkToken,
  isStockError,
  openLinkToken,
  paymentModes,
  sameAddress,
  sealLinkToken,
  snapshotHash,
  toPaise,
  validateCustomerDetails,
} from "./rules.js";
import { createSourceAdapters } from "./sources.js";

// Admin-initiated offline payment links (docs/OFFLINE_PAYMENT_LINKS.md).
//
//   admin:    createLink / revokeLink / getLinkState
//   public:   publicView (no auth)
//   customer: bindCustomer -> initiate -> status (Google sign-in)
//   gateway:  processVerification (PhonePe webhook, admin reconcile, status)
//
// Rules:
// - the amount always comes from the source document in the database
//   (pre-invoice or quotation); request bodies never carry it
// - only a server-to-server PhonePe status check can mark anything paid;
//   the browser redirect never does
// - every step is idempotent; one source document gets at most one invoice
// - customer phone numbers and addresses are never logged
//
// Dependencies are injected so tests can use in-memory fakes.

const ACTIVE_ATTEMPT = ["created", "pending"];
const FINAL_REFUND = ["refunded", "partially_refunded"];

const id = (value) => (value ? String(value) : null);
const iso = (value) => (value ? new Date(value).toISOString() : null);

export const createOfflinePaymentService = ({
  store,
  gateway,
  invoiceWriter,
  config,
  audit = async () => {},
  // Payment notifications (admin alert, payment receipt + invoice link).
  // Called without awaiting; a notification never fails a payment.
  notifier = {},
  now = () => new Date(),
  log = console,
}) => {
  const notify = (name, payload) => {
    if (typeof notifier[name] !== "function") return;
    Promise.resolve()
      .then(() => notifier[name](payload))
      .catch((error) =>
        log.error("Offline payment notification failed", {
          name,
          code: error?.code,
          message: error?.message,
        }),
      );
  };
  const adapters = createSourceAdapters({ store, now });
  const adapterFor = (kind) => {
    const adapter = adapters[kind];
    if (!adapter)
      throw new OfflinePaymentError(
        400,
        "INVALID_SOURCE",
        "Unknown document type",
      );
    return adapter;
  };
  const later = (ms) => new Date(now().getTime() + ms);
  const payUrl = (token) => `${config.publicBaseUrl}/pay/${token}`;

  const effectiveStatus = (link) =>
    link.status === "active" && new Date(link.expiresAt) <= now()
      ? "expired"
      : link.status;

  // Link + its document + whether the document still matches the link.
  const resolve = async (token) => {
    const link = await store.findLinkByHash(hashLinkToken(token));
    if (!link) return null;
    const adapter = adapterFor(link.source.kind);
    const doc = await adapter.load(link.source.id);
    const status = effectiveStatus(link);
    if (status === "expired" && link.status === "active")
      await store.updateLink(
        link._id,
        { status: "active" },
        { $set: { status: "expired" } },
      );
    const snapshot = doc ? adapter.payableSnapshot(doc) : null;
    return {
      link: { ...link, status },
      adapter,
      doc,
      snapshot,
      matches:
        Boolean(snapshot) && snapshotHash(snapshot) === link.snapshotHash,
      payable: doc ? adapter.isPayable(doc).ok : false,
    };
  };

  const usable = (r) =>
    r && r.link.status === "active" && r.matches && r.payable;

  const requireBoundTo = (link, user) => {
    if (!link.userId)
      throw new OfflinePaymentError(
        409,
        "CUSTOMER_DETAILS_REQUIRED",
        "Confirm your details before paying",
      );
    if (String(link.userId) !== String(user._id))
      throw new OfflinePaymentError(
        403,
        "LINK_BOUND_TO_ANOTHER_USER",
        "This payment link is linked to a different Aquakart account",
      );
  };

  const publicLines = (snapshot) =>
    snapshot.lines.map((line) => ({
      name: line.name,
      description: line.description,
      quantity: line.quantity,
    }));

  // ---- Conversion (after a verified payment) -----------------------------

  const linkInvoiceToCustomer = async (link, invoice) => {
    if (!link.userId) return;
    const user = await store.findUserById(link.userId);
    if (!user) return;
    if (user.firebaseUid && !invoice.firebaseUid)
      await store.setInvoiceOwner(invoice._id, user.firebaseUid);
    const already = (user.invoices || []).some(
      (entry) => String(entry.invoiceId) === String(invoice._id),
    );
    if (!already)
      await store.updateUser(user._id, {
        $push: {
          invoices: {
            invoiceId: invoice._id,
            invoiceNo: invoice.invoiceNo || "",
            linkedAt: now(),
          },
        },
      });
  };

  const ensureConverted = async (linkId, paymentType) => {
    const claimed = await store.updateLink(
      linkId,
      {
        status: "paid",
        $or: [
          { "conversion.status": { $in: ["none", "failed", "blocked_stock"] } },
          { "conversion.status": null },
          {
            "conversion.status": "in_progress",
            "conversion.lockedUntil": { $lt: now() },
          },
        ],
      },
      {
        $set: {
          "conversion.status": "in_progress",
          "conversion.lockedUntil": later(2 * 60 * 1000),
          "conversion.at": now(),
        },
        $inc: { "conversion.attempts": 1 },
      },
    );
    if (!claimed) return store.findLinkById(linkId);
    const adapter = adapterFor(claimed.source.kind);
    const finish = (set) =>
      store.updateLink(
        linkId,
        {},
        {
          $set: {
            ...set,
            "conversion.lockedUntil": null,
            "conversion.at": now(),
          },
        },
      );
    try {
      const doc = await adapter.load(claimed.source.id);
      let invoice =
        (doc?.convertedToInvoice &&
          (await store.findInvoiceById(doc.convertedToInvoice))) ||
        (await store.findInvoiceBySource(
          claimed.source.kind,
          claimed.source.id,
        ));
      if (!invoice) {
        const payload = adapter.invoicePayload(doc, {
          paymentType: paymentType || paymentModes(null).invoice,
          fallbackAddress: claimed.deliveryAddress,
        });
        const { isValid, errors } = invoiceWriter.validate(payload);
        if (!isValid)
          return finish({
            "conversion.status": "needs_review",
            "conversion.lastError": `Invoice data incomplete: ${Object.values(errors)[0]}`,
          });
        try {
          invoice = (await invoiceWriter.persist(payload)).invoice;
        } catch (error) {
          // Unique sourcePreInvoiceId: another call created it first.
          if (error?.code !== 11000) throw error;
          invoice = await store.findInvoiceBySource(
            claimed.source.kind,
            claimed.source.id,
          );
          if (!invoice) throw error;
        }
      }
      await adapter.attachInvoice(doc, invoice);
      await linkInvoiceToCustomer(claimed, invoice);
      notify("invoiceReady", { link: claimed, invoice });
      await audit({
        action: "payment_link.invoice_created",
        resourceType: "payment_link",
        resourceId: claimed._id,
        metadata: {
          sourceKind: claimed.source.kind,
          sourceNumber: claimed.source.number,
          invoiceId: id(invoice._id),
          invoiceNo: invoice.invoiceNo,
        },
      });
      return finish({
        "conversion.status": "done",
        "conversion.invoiceId": invoice._id,
        "conversion.invoiceNo": invoice.invoiceNo || "",
        "conversion.lastError": null,
      });
    } catch (error) {
      log.error("Offline payment invoice conversion failed", {
        linkId: id(linkId),
        code: error?.code,
        message: error?.message,
      });
      return finish({
        "conversion.status": isStockError(error) ? "blocked_stock" : "failed",
        "conversion.lastError": String(
          error?.message || "Conversion failed",
        ).slice(0, 300),
      });
    }
  };

  // ---- Gateway verification (webhook, admin reconcile, status) -----------

  const processVerification = async (attemptInput, verification, source) => {
    let attempt = attemptInput;
    if (FINAL_REFUND.includes(attempt.status)) return attempt;
    const history = (status, note) => ({
      statusHistory: { status, at: now(), source, ...(note ? { note } : {}) },
    });

    if (verification.status !== "paid") {
      const status = verification.status === "pending" ? "pending" : "failed";
      const updated = await store.updateAttempt(
        attempt._id,
        { status: { $in: ACTIVE_ATTEMPT } },
        {
          $set: { status, gatewayResponse: verification.raw },
          $push: history(status),
        },
      );
      return updated || store.findAttempt(attempt._id);
    }

    // Strict checks before anything becomes paid.
    const problems = [];
    if (
      !verification.merchantId ||
      verification.merchantId !== gateway.merchantId()
    )
      problems.push("merchant");
    if (verification.merchantTransactionId !== attempt.merchantTransactionId)
      problems.push("transaction");
    if (String(attempt.currency || "INR").toUpperCase() !== "INR")
      problems.push("currency");
    if (toPaise(verification.amount) !== toPaise(attempt.amount))
      problems.push("amount");
    if (problems.length) {
      await store.updateAttempt(
        attempt._id,
        {},
        {
          $push: history("verification_rejected", problems.join(",")),
        },
      );
      await audit({
        action: "payment_link.verification_rejected",
        resourceType: "payment",
        resourceId: attempt._id,
        metadata: { problems, source },
      });
      throw new OfflinePaymentError(
        400,
        "VERIFICATION_MISMATCH",
        "Gateway verification did not match the payment",
        { problems },
      );
    }

    const paidAt = now();
    attempt =
      (await store.updateAttempt(
        attempt._id,
        { status: { $nin: ["paid", ...FINAL_REFUND] } },
        {
          $set: {
            status: "paid",
            verifiedAt: paidAt,
            gatewayTransactionId:
              verification.gatewayTransactionId || attempt.gatewayTransactionId,
            gatewayResponse: verification.raw,
          },
          $push: history("paid"),
        },
      )) || (await store.findAttempt(attempt._id));
    if (attempt.status !== "paid") return attempt;

    let link = await store.findLinkById(attempt.paymentLinkId);
    if (!link) return attempt;
    if (link.status !== "paid") {
      const flags = [];
      if (link.status === "revoked" || effectiveStatus(link) === "expired")
        flags.push("PAID_AFTER_REVOKE_OR_EXPIRY");
      const marked = await store.updateLink(
        link._id,
        { status: { $ne: "paid" } },
        {
          $set: {
            status: "paid",
            paidAt: attempt.verifiedAt || paidAt,
            paidAttemptId: attempt._id,
            gatewayTransactionId: attempt.gatewayTransactionId || null,
            amountPaid: attempt.amount,
            initiateLockUntil: null,
          },
          ...(flags.length ? { $push: { reviewFlags: { $each: flags } } } : {}),
        },
      );
      link = marked || (await store.findLinkById(link._id));
    }
    // A second, different successful payment for the same link: record it
    // for a refund decision, never a second invoice.
    if (String(link.paidAttemptId) !== String(attempt._id)) {
      if (!(link.reviewFlags || []).includes("DUPLICATE_PAYMENT"))
        await store.updateLink(
          link._id,
          {},
          {
            $push: { reviewFlags: "DUPLICATE_PAYMENT" },
          },
        );
      await audit({
        action: "payment_link.duplicate_payment",
        resourceType: "payment_link",
        resourceId: link._id,
        metadata: {
          attemptId: id(attempt._id),
          firstAttemptId: id(link.paidAttemptId),
        },
      });
      return attempt;
    }

    const adapter = adapterFor(link.source.kind);
    const modes = paymentModes(verification.paymentInstrumentType);
    let doc = await adapter.load(link.source.id);
    notify("linkPaid", { link, doc });
    if (doc && doc.payment?.status !== "Paid") {
      // The document must still charge exactly what was paid.
      if (
        toPaise(adapter.payableSnapshot(doc).total) !== toPaise(attempt.amount)
      ) {
        await store.updateLink(
          link._id,
          {},
          {
            $set: {
              "conversion.status": "needs_review",
              "conversion.lastError":
                "The document total changed after payment started",
            },
            $push: { reviewFlags: "AMOUNT_CHANGED_AFTER_PAYMENT" },
          },
        );
        return attempt;
      }
      doc = await adapter.markPaid(doc, {
        amount: attempt.amount,
        transactionId:
          attempt.gatewayTransactionId || attempt.merchantTransactionId,
        paidAt: attempt.verifiedAt || paidAt,
        mode: modes.document,
      });
      await audit({
        action: "payment_link.paid",
        resourceType: "payment_link",
        resourceId: link._id,
        metadata: {
          sourceKind: link.source.kind,
          sourceNumber: link.source.number,
          amount: attempt.amount,
          attemptId: id(attempt._id),
          source,
        },
      });
    }
    if (
      link.conversion?.status !== "done" &&
      link.conversion?.status !== "needs_review"
    )
      await ensureConverted(link._id, modes.invoice);
    return store.findAttempt(attempt._id);
  };

  const verifyAndProcess = async (attempt, source) => {
    const verification = await gateway.verify(attempt.merchantTransactionId);
    return processVerification(attempt, verification, source);
  };

  // ---- Admin -------------------------------------------------------------

  const linkSummary = (link, extra = {}) =>
    link && {
      linkId: id(link._id),
      status: effectiveStatus(link),
      source: {
        kind: link.source.kind,
        id: id(link.source.id),
        number: link.source.number || "",
      },
      amount: link.amount,
      currency: link.currency,
      expiresAt: iso(link.expiresAt),
      createdAt: iso(link.createdAt),
      boundToCustomer: Boolean(link.userId),
      reviewFlags: link.reviewFlags || [],
      paidAt: iso(link.paidAt),
      amountPaid: link.amountPaid ?? null,
      gatewayTransactionId: link.gatewayTransactionId || null,
      // Payment attempt that paid this link; the id for
      // POST /v1/crm/payments/:id/reconcile.
      paidAttemptId: id(link.paidAttemptId),
      conversion: {
        status: link.conversion?.status || "none",
        invoiceId: id(link.conversion?.invoiceId),
        invoiceNo: link.conversion?.invoiceNo || null,
        lastError: link.conversion?.lastError || null,
      },
      ...extra,
    };

  const revokeActive = (kind, sourceId, actor, reason) =>
    store.revokeActiveLinks(kind, sourceId, {
      at: now(),
      by: actor?._id || null,
      reason,
    });

  return {
    adapters,
    processVerification,
    revokeActive,
    linkSummary,

    async createLink({ kind, sourceId, actor, notifyCustomer = true }) {
      const adapter = adapterFor(kind);
      const doc = await adapter.load(sourceId);
      if (!doc)
        throw new OfflinePaymentError(
          404,
          "SOURCE_NOT_FOUND",
          "Document not found",
        );
      if (kind === "quotation" && doc.convertedToPreInvoice)
        throw new OfflinePaymentError(
          409,
          "USE_PRE_INVOICE",
          "This quotation was moved to a pre-invoice; create the payment link on the pre-invoice",
          {
            preInvoiceId: id(doc.convertedToPreInvoice),
            preInvoiceNo: doc.convertedToPreInvoiceNo || null,
          },
        );
      const payable = adapter.isPayable(doc);
      if (!payable.ok)
        throw new OfflinePaymentError(
          409,
          "NOT_PAYABLE",
          "This document can't be paid online",
          { reason: payable.reason },
        );
      const snapshot = adapter.payableSnapshot(doc);
      if (!snapshot.phone)
        throw new OfflinePaymentError(
          400,
          "CUSTOMER_PHONE_INVALID",
          "The document needs a valid Indian mobile number before a payment link can be sent",
        );
      if (!(await store.isGatewayEnabled("phonepe")))
        throw new OfflinePaymentError(
          503,
          "GATEWAY_DISABLED",
          "Online payments are not configured",
        );

      const create = async () => {
        await revokeActive(kind, doc._id, actor, "regenerated");
        const token = createLinkToken();
        const link = await store.createLink({
          tokenHash: hashLinkToken(token),
          ...(config.tokenKey
            ? { tokenSealed: sealLinkToken(token, config.tokenKey) }
            : {}),
          source: { kind, id: doc._id, number: snapshot.number },
          phoneNormalized: snapshot.phone,
          amount: snapshot.total,
          currency: snapshot.currency,
          snapshotHash: snapshotHash(snapshot),
          expiresAt: later(config.linkTtlHours * 60 * 60 * 1000),
          status: "active",
          createdBy: actor?._id || null,
          conversion: { status: "none", attempts: 0 },
        });
        return { token, link };
      };
      let created;
      try {
        created = await create();
      } catch (error) {
        if (error?.code !== 11000) throw error;
        created = await create(); // a parallel create won; replace it
      }
      await adapter.markPending(doc);
      await audit({
        action: "payment_link.create",
        adminUserId: actor?._id,
        resourceType: "payment_link",
        resourceId: created.link._id,
        metadata: {
          sourceKind: kind,
          sourceId: id(doc._id),
          sourceNumber: snapshot.number,
          amount: snapshot.total,
        },
      });
      const url = payUrl(created.token);
      // Send the link to the customer on WhatsApp (in the background).
      let customerNotification = "disabled";
      if (notifyCustomer !== false) {
        customerNotification =
          typeof notifier.linkCreated === "function" &&
          notifier.linkCreatedConfigured?.() !== false
            ? "queued"
            : "not_configured";
        if (customerNotification === "queued")
          notify("linkCreated", { link: created.link, doc, url });
      }
      return {
        // Shown once: only its hash is stored.
        url,
        ...linkSummary(created.link),
        customerNotification,
      };
    },

    // CRM "Send": re-sends the active link (same URL) to the customer on
    // WhatsApp and waits for the provider, so staff see the real outcome.
    async sendLink({ kind, sourceId, actor }) {
      const adapter = adapterFor(kind);
      const link = await store.findLatestLink(kind, sourceId);
      if (!link || effectiveStatus(link) !== "active")
        throw new OfflinePaymentError(
          409,
          "NO_ACTIVE_LINK",
          "There is no active payment link to send. Create a new link.",
        );
      const doc = await adapter.load(sourceId);
      if (
        !doc ||
        snapshotHash(adapter.payableSnapshot(doc)) !== link.snapshotHash
      )
        throw new OfflinePaymentError(
          409,
          "LINK_OUTDATED",
          "The document changed after this link was made. Create a new link.",
        );
      const token =
        config.tokenKey && link.tokenSealed
          ? openLinkToken(link.tokenSealed, config.tokenKey)
          : null;
      if (!token || hashLinkToken(token) !== link.tokenHash)
        throw new OfflinePaymentError(
          409,
          "LINK_RESEND_UNAVAILABLE",
          "This link can't be re-sent (it was created before sending was available). Create a new link; it is sent automatically.",
        );
      if (
        typeof notifier.linkCreated !== "function" ||
        notifier.linkCreatedConfigured?.() === false
      )
        throw new OfflinePaymentError(
          503,
          "NOTIFICATIONS_NOT_CONFIGURED",
          "The WhatsApp payment-link template is not configured on the server.",
        );
      const minute = Math.floor(now().getTime() / 60000);
      const result = await notifier.linkCreated({
        link,
        doc,
        url: payUrl(token),
        dedupeKey: `payment-link:${id(link._id)}:resend:${minute}`,
      });
      if (result?.duplicate)
        throw new OfflinePaymentError(
          429,
          "ALREADY_SENT",
          "The link was just sent. Wait a minute before sending it again.",
        );
      if (!result?.sent)
        throw new OfflinePaymentError(
          502,
          "SEND_FAILED",
          result?.errors?.at(-1)?.message ||
            "WhatsApp delivery failed. Try again or share the link manually.",
          { reason: result?.skipped || result?.errors?.at(-1)?.code || null },
        );
      await audit({
        action: "payment_link.sent",
        adminUserId: actor?._id,
        resourceType: "payment_link",
        resourceId: link._id,
        metadata: {
          sourceKind: kind,
          sourceNumber: link.source.number,
          channel: result.channel,
        },
      });
      return {
        sent: true,
        channel: result.channel || "whatsapp",
        sentAt: iso(now()),
        link: linkSummary(link, { matchesDocument: true }),
      };
    },

    async revokeLink({ kind, sourceId, actor }) {
      const adapter = adapterFor(kind);
      const doc = await adapter.load(sourceId);
      if (!doc)
        throw new OfflinePaymentError(
          404,
          "SOURCE_NOT_FOUND",
          "Document not found",
        );
      const revoked = await revokeActive(
        kind,
        doc._id,
        actor,
        "revoked_by_admin",
      );
      await audit({
        action: "payment_link.revoke",
        adminUserId: actor?._id,
        resourceType: "payment_link",
        resourceId: id(doc._id),
        metadata: { sourceKind: kind, revoked },
      });
      return { revoked };
    },

    async getLinkState({ kind, sourceId }) {
      adapterFor(kind);
      const link = await store.findLatestLink(kind, sourceId);
      if (!link) return { link: null };
      const doc = await adapterFor(kind).load(sourceId);
      const valid =
        Boolean(doc) &&
        snapshotHash(adapterFor(kind).payableSnapshot(doc)) ===
          link.snapshotHash;
      return { link: linkSummary(link, { matchesDocument: valid }) };
    },

    // ---- Public / customer -------------------------------------------------

    async publicView(token) {
      const r = await resolve(token);
      if (r?.link.status === "paid")
        return {
          documentType: r.link.source.kind,
          documentNumber: r.link.source.number || "",
          products: r.snapshot ? publicLines(r.snapshot) : [],
          subTotal: r.snapshot?.subTotal ?? null,
          discount: r.snapshot?.discount ?? null,
          tax: r.snapshot?.tax ?? null,
          amount: r.link.amountPaid ?? r.link.amount,
          currency: r.link.currency,
          expiresAt: iso(r.link.expiresAt),
          payable: false,
          state: "paid",
          requiresSignIn: true,
        };
      if (!usable(r)) throw LINK_UNAVAILABLE();
      return {
        documentType: r.link.source.kind,
        documentNumber: r.snapshot.number,
        products: publicLines(r.snapshot),
        subTotal: r.snapshot.subTotal,
        discount: r.snapshot.discount,
        tax: r.snapshot.tax,
        amount: r.snapshot.total,
        currency: r.snapshot.currency,
        expiresAt: iso(r.link.expiresAt),
        payable: true,
        state: "payable",
        requiresSignIn: true,
      };
    },

    async bindCustomer(token, sessionUser, body) {
      const r = await resolve(token);
      if (r?.link.status === "paid")
        throw new OfflinePaymentError(
          409,
          "ALREADY_PAID",
          "This document is already paid",
        );
      if (!usable(r)) throw LINK_UNAVAILABLE();
      const details = validateCustomerDetails(body);
      const bound = await store.updateLink(
        r.link._id,
        {
          status: "active",
          $or: [{ userId: null }, { userId: sessionUser._id }],
        },
        {
          $set: {
            userId: sessionUser._id,
            boundAt: r.link.boundAt || now(),
            deliveryAddress: formatAddress(details.address),
          },
        },
      );
      if (!bound)
        requireBoundTo(await store.findLinkById(r.link._id), sessionUser);

      // Profile: append the address (never overwrite) and the alternate number.
      const user = await store.findUserById(sessionUser._id);
      const update = { $set: {}, $push: {} };
      if (!(user.addresses || []).some((a) => sameAddress(a, details.address)))
        update.$push.addresses = details.address;
      if (!user.selectedAddress?.street)
        update.$set.selectedAddress = details.address;
      if (details.alternatePhone)
        update.$set.alternatePhone = details.alternatePhone;
      if (!Object.keys(update.$push).length) delete update.$push;
      if (!Object.keys(update.$set).length) delete update.$set;
      if (Object.keys(update).length) await store.updateUser(user._id, update);

      // The document's phone belongs to a different account: continue with
      // the signed-in account (never merge) and flag it for an admin.
      const documentPhone = r.link.phoneNormalized;
      let flagged = false;
      if (documentPhone && normalizeIndianPhone(user.phone) !== documentPhone) {
        const other = await store.findUserByPhone(documentPhone, user._id);
        if (
          other &&
          !(bound?.reviewFlags || r.link.reviewFlags || []).includes(
            "PHONE_ON_OTHER_ACCOUNT",
          )
        ) {
          await store.updateLink(
            r.link._id,
            {},
            {
              $push: { reviewFlags: "PHONE_ON_OTHER_ACCOUNT" },
            },
          );
          await audit({
            action: "payment_link.phone_on_other_account",
            resourceType: "payment_link",
            resourceId: r.link._id,
            metadata: { userId: id(user._id), otherUserId: id(other._id) },
          });
        }
        flagged = Boolean(other);
      }
      return {
        bound: true,
        documentNumber: r.snapshot.number,
        amount: r.snapshot.total,
        currency: r.snapshot.currency,
        flaggedForReview: flagged,
      };
    },

    async initiate(token, sessionUser) {
      const r = await resolve(token);
      if (r?.link.status === "paid")
        throw new OfflinePaymentError(
          409,
          "ALREADY_PAID",
          "This document is already paid",
        );
      if (!usable(r)) throw LINK_UNAVAILABLE();
      requireBoundTo(r.link, sessionUser);
      if (!(await store.isGatewayEnabled("phonepe")))
        throw new OfflinePaymentError(
          503,
          "GATEWAY_DISABLED",
          "Online payments are not available right now",
        );

      const attempts = await store.findAttemptsForLink(r.link._id);
      if (attempts.some((attempt) => attempt.status === "paid"))
        throw new OfflinePaymentError(
          409,
          "ALREADY_PAID",
          "This document is already paid",
        );

      const claimed = await store.updateLink(
        r.link._id,
        {
          status: "active",
          $or: [
            { initiateLockUntil: null },
            { initiateLockUntil: { $lt: now() } },
          ],
        },
        { $set: { initiateLockUntil: later(30 * 1000) } },
      );
      if (!claimed)
        throw new OfflinePaymentError(
          409,
          "PAYMENT_IN_PROGRESS",
          "A payment is already being started; try again in a few seconds",
        );
      try {
        const open = attempts.find((attempt) =>
          ACTIVE_ATTEMPT.includes(attempt.status),
        );
        if (open) {
          let checked = open;
          try {
            checked = await verifyAndProcess(open, "initiate-recheck");
          } catch (error) {
            if (error instanceof OfflinePaymentError) throw error;
            checked = open; // gateway unreachable: decide on age below
          }
          if (checked.status === "paid")
            throw new OfflinePaymentError(
              409,
              "ALREADY_PAID",
              "This document is already paid",
            );
          const fresh =
            now() - new Date(open.createdAt) <
            config.attemptTtlMinutes * 60 * 1000;
          if (checked.status === "pending" && fresh && open.redirectUrl)
            return {
              redirectUrl: open.redirectUrl,
              amount: open.amount,
              currency: open.currency,
              status: "pending",
              reused: true,
            };
          if (ACTIVE_ATTEMPT.includes(checked.status))
            await store.updateAttempt(
              open._id,
              { status: { $in: ACTIVE_ATTEMPT } },
              {
                $set: { status: "expired" },
                $push: {
                  statusHistory: {
                    status: "expired",
                    at: now(),
                    source: "initiate",
                  },
                },
              },
            );
        }

        const payload = r.adapter.invoicePayload(r.doc, {
          paymentType: "online",
          fallbackAddress: r.link.deliveryAddress,
        });
        try {
          await invoiceWriter.assertStock(payload.products);
        } catch (error) {
          if (isStockError(error))
            throw new OfflinePaymentError(
              409,
              "OUT_OF_STOCK",
              "Some items are not in stock right now. Please contact Aquakart.",
            );
          throw error;
        }

        const merchantTransactionId = `AQPL${now().getTime()}${crypto
          .randomBytes(4)
          .toString("hex")
          .toUpperCase()}`;
        const amount = r.snapshot.total;
        const attempt = await store.createAttempt({
          source: "CRM_OFFLINE",
          sourceKind: r.link.source.kind,
          sourceId: r.link.source.id,
          paymentLinkId: r.link._id,
          userId: sessionUser._id,
          gateway: "phonepe",
          idempotencyKey: `offline:${merchantTransactionId}`,
          merchantTransactionId,
          amount,
          currency: r.snapshot.currency,
          status: "created",
          statusHistory: [
            { status: "created", at: now(), source: "offline-initiate" },
          ],
        });
        let result;
        try {
          result = await gateway.create({
            transactionId: merchantTransactionId,
            userId: sessionUser._id,
            amount,
            phone: r.snapshot.phone,
            redirectUrl: `${payUrl(token)}?return=1`,
          });
          if (!result?.redirectUrl)
            throw new Error("No redirect URL from gateway");
        } catch (error) {
          await store.updateAttempt(
            attempt._id,
            {},
            {
              $set: { status: "failed" },
              $push: {
                statusHistory: {
                  status: "failed",
                  at: now(),
                  source: "gateway-create",
                },
              },
            },
          );
          throw new OfflinePaymentError(
            error?.status === 503 ? 503 : 502,
            "GATEWAY_ERROR",
            "Could not start the payment. Please try again.",
          );
        }
        await store.updateAttempt(
          attempt._id,
          {},
          {
            $set: {
              status: "pending",
              redirectUrl: result.redirectUrl,
              gatewayTransactionId: result.transactionId || null,
              gatewayResponse: result.raw,
            },
            $push: {
              statusHistory: {
                status: "pending",
                at: now(),
                source: "gateway-create",
              },
            },
          },
        );
        return {
          redirectUrl: result.redirectUrl,
          amount,
          currency: r.snapshot.currency,
          status: "pending",
          reused: false,
        };
      } finally {
        await store.updateLink(
          r.link._id,
          {},
          { $set: { initiateLockUntil: null } },
        );
      }
    },

    async status(token, sessionUser) {
      const link = await store.findLinkByHash(hashLinkToken(token));
      if (!link) throw LINK_UNAVAILABLE();
      requireBoundTo(link, sessionUser);
      let attempts = await store.findAttemptsForLink(link._id);
      const latest = attempts[0];
      // Server-side check with PhonePe (never the browser's word) when the
      // customer returns before the webhook arrives.
      if (
        latest &&
        ACTIVE_ATTEMPT.includes(latest.status) &&
        latest.redirectUrl
      ) {
        try {
          await verifyAndProcess(latest, "status-check");
        } catch (error) {
          log.error("Offline payment status check failed", {
            attemptId: id(latest._id),
            code: error?.code,
          });
        }
        attempts = await store.findAttemptsForLink(link._id);
      }
      const current = await store.findLinkById(link._id);
      const paid = attempts.find(
        (attempt) => String(attempt._id) === String(current.paidAttemptId),
      );
      const shown = paid || attempts[0];
      const adapter = adapterFor(current.source.kind);
      const doc = await adapter.load(current.source.id);
      const snapshot = doc ? adapter.payableSnapshot(doc) : null;
      const invoice = current.conversion?.invoiceId
        ? await store.findInvoiceById(current.conversion.invoiceId)
        : null;
      return {
        status: shown ? shown.status : "not_started",
        linkStatus: effectiveStatus(current),
        source: "CRM_OFFLINE",
        documentType: current.source.kind,
        documentNumber: current.source.number || "",
        quotationNo:
          current.source.kind === "quotation"
            ? current.source.number
            : doc?.sourceQuotationNo || null,
        preInvoiceNo:
          current.source.kind === "pre_invoice" ? current.source.number : null,
        invoiceNo: invoice?.invoiceNo || null,
        invoiceReady: current.conversion?.status === "done",
        products: snapshot ? publicLines(snapshot) : [],
        amount: current.amount,
        amountPaid: paid ? paid.amount : 0,
        currency: current.currency,
        gatewayTransactionId: paid
          ? paid.gatewayTransactionId || paid.merchantTransactionId
          : null,
        paidAt: iso(current.paidAt),
      };
    },

    // Admin reconcile / retry for a paid attempt whose invoice is missing.
    async retryConversion(attempt) {
      const link = attempt.paymentLinkId
        ? await store.findLinkById(attempt.paymentLinkId)
        : null;
      if (!link || link.status !== "paid") return link;
      return ensureConverted(link._id, null);
    },
  };
};
