import AnalyticsVisit from "../models/analyticsVisit.js";

const MAX_TEXT = 500;
const clampText = (value = "") => String(value).slice(0, MAX_TEXT);
const safeDuration = (value) => Math.max(0, Math.min(Number(value) || 0, 24 * 60 * 60));

export const recordVisitEvent = async (req, res) => {
  try {
    const { visitId, sessionId, pagePath, pageTitle, referrer, event, durationSeconds } = req.body || {};
    if (!visitId || !sessionId || !pagePath) {
      return res.status(400).json({ success: false, message: "visitId, sessionId and pagePath are required" });
    }

    const now = new Date();
    const update = {
      $set: {
        sessionId: clampText(sessionId),
        pagePath: clampText(pagePath),
        pageTitle: clampText(pageTitle),
        referrer: clampText(referrer),
        lastSeenAt: now,
        durationSeconds: safeDuration(durationSeconds),
      },
      $setOnInsert: { visitId: clampText(visitId), startedAt: now },
    };

    if (event === "leave") update.$set.endedAt = now;

    const visit = await AnalyticsVisit.findOneAndUpdate(
      { visitId: clampText(visitId) },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return res.status(event === "open" ? 201 : 200).json({ success: true, id: visit._id });
  } catch (error) {
    console.error("recordVisitEvent error", error);
    return res.status(500).json({ success: false, message: "Unable to record analytics event" });
  }
};

export const getLiveAnalytics = async (_req, res) => {
  try {
    const now = new Date();
    const activeSince = new Date(now.getTime() - 2 * 60 * 1000);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [activeVisits, todayViews, todaySessions, avgDuration, topPages] = await Promise.all([
      AnalyticsVisit.find({ lastSeenAt: { $gte: activeSince } })
        .sort({ lastSeenAt: -1 })
        .limit(50)
        .lean(),
      AnalyticsVisit.countDocuments({ startedAt: { $gte: todayStart } }),
      AnalyticsVisit.distinct("sessionId", { startedAt: { $gte: todayStart } }),
      AnalyticsVisit.aggregate([
        { $match: { startedAt: { $gte: todayStart }, durationSeconds: { $gt: 0 } } },
        { $group: { _id: null, average: { $avg: "$durationSeconds" } } },
      ]),
      AnalyticsVisit.aggregate([
        { $match: { startedAt: { $gte: dayAgo } } },
        {
          $group: {
            _id: "$pagePath",
            pageTitle: { $first: "$pageTitle" },
            views: { $sum: 1 },
            uniqueSessions: { $addToSet: "$sessionId" },
            averageDurationSeconds: { $avg: "$durationSeconds" },
          },
        },
        {
          $project: {
            _id: 0,
            pagePath: "$_id",
            pageTitle: 1,
            views: 1,
            users: { $size: "$uniqueSessions" },
            averageDurationSeconds: { $round: ["$averageDurationSeconds", 0] },
          },
        },
        { $sort: { views: -1 } },
        { $limit: 20 },
      ]),
    ]);

    const sessions = new Map();
    for (const visit of activeVisits) {
      if (!sessions.has(visit.sessionId)) sessions.set(visit.sessionId, visit);
    }

    return res.json({
      success: true,
      generatedAt: now,
      summary: {
        activeUsers: sessions.size,
        pageViewsToday: todayViews,
        visitorsToday: todaySessions.length,
        averageEngagementSeconds: Math.round(avgDuration?.[0]?.average || 0),
      },
      liveVisitors: Array.from(sessions.values()).map((visit) => ({
        sessionId: visit.sessionId,
        pagePath: visit.pagePath,
        pageTitle: visit.pageTitle,
        referrer: visit.referrer,
        startedAt: visit.startedAt,
        lastSeenAt: visit.lastSeenAt,
        durationSeconds: visit.durationSeconds,
      })),
      topPages,
    });
  } catch (error) {
    console.error("getLiveAnalytics error", error);
    return res.status(500).json({ success: false, message: "Unable to load analytics" });
  }
};
