import AquaQuotation from "../models/crm/quotation.js";
import { sendQuotationWhatsApp } from "../services/quotation/quotationWhatsApp.js";

const ACTIVE_STATUSES = ["Sent", "Payment Pending"];

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const releaseAfterFailure = async (quotation, error, now) => {
  const retryHours = number(process.env.QUOTATION_FOLLOWUP_RETRY_HOURS, 6);
  quotation.whatsapp.followUpLockUntil = null;
  quotation.whatsapp.lastFollowUpError =
    String(error?.code || error?.message || "FOLLOWUP_FAILED").slice(0, 500);
  quotation.whatsapp.nextFollowUpAt = new Date(
    now.getTime() + retryHours * 60 * 60 * 1000,
  );
  await quotation.save();
};

export const runQuotationFollowUps = async (now = new Date()) => {
  const candidateIds = await AquaQuotation.find({
    status: { $in: ACTIVE_STATUSES },
    "whatsapp.followUpEnabled": true,
    "whatsapp.nextFollowUpAt": { $ne: null, $lte: now },
    $expr: {
      $lt: [
        { $ifNull: ["$whatsapp.followUpCount", 0] },
        { $ifNull: ["$whatsapp.maxFollowUps", 3] },
      ],
    },
  })
    .select("_id")
    .limit(100)
    .lean();

  const results = [];
  const lockUntil = new Date(now.getTime() + 10 * 60 * 1000);

  for (const candidate of candidateIds) {
    const quotation = await AquaQuotation.findOneAndUpdate(
      {
        _id: candidate._id,
        status: { $in: ACTIVE_STATUSES },
        "whatsapp.followUpEnabled": true,
        "whatsapp.nextFollowUpAt": { $ne: null, $lte: now },
        $or: [
          { "whatsapp.followUpLockUntil": null },
          { "whatsapp.followUpLockUntil": { $exists: false } },
          { "whatsapp.followUpLockUntil": { $lt: now } },
        ],
      },
      { $set: { "whatsapp.followUpLockUntil": lockUntil } },
      { new: true },
    );

    if (!quotation) continue;

    try {
      const result = await sendQuotationWhatsApp({
        quotation,
        followUp: true,
        now,
      });
      results.push({
        quotationId: String(quotation._id),
        status: result.skipped ? "skipped" : "sent",
        reason: result.reason,
      });
    } catch (error) {
      await releaseAfterFailure(quotation, error, now);
      results.push({
        quotationId: String(quotation._id),
        status: "failed",
        error: error.code || error.message,
      });
    }
  }

  return results;
};

export const startQuotationFollowUps = () => {
  if (
    String(process.env.QUOTATION_FOLLOWUPS_ENABLED || "true") !== "true"
  ) {
    return null;
  }

  const minute = Math.min(
    59,
    Math.max(0, number(process.env.QUOTATION_FOLLOWUP_RUN_MINUTE, 10)),
  );
  let timer;

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(minute, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);

    timer = setTimeout(async () => {
      try {
        await runQuotationFollowUps();
      } catch (error) {
        console.error("Quotation follow-up job failed", error);
      } finally {
        scheduleNext();
      }
    }, next.getTime() - now.getTime());
  };

  scheduleNext();
  return { stop: () => clearTimeout(timer) };
};
