import { money, tierForDistance } from "./rules.js";

// Transport rate comparison: Aquakart's own rate card against Porter and
// Rapido. Informational only; it never changes the internal charge.
//
// kinds:
//   internal          Aquakart rate card (what is actually charged)
//   live_quote        a quote from an official provider API
//   manual_benchmark  computed from admin-maintained rates (not a live quote)
//
// No official Porter/Rapido quote API is integrated (none is publicly
// available without a partner agreement), so live quotes report as
// unavailable. Add one to `liveProviders` when an integration exists:
//   { provider, quote({ distanceKm, durationMinutes, origin, destination }) }

export const benchmarkFare = (benchmark, { distanceKm, durationMinutes }) => {
  const extraKm = Math.max(
    0,
    Number(distanceKm) - Number(benchmark.includedKm || 0),
  );
  const fare =
    Number(benchmark.baseFare) +
    extraKm * Number(benchmark.perKm) +
    Number(durationMinutes || 0) * Number(benchmark.perMinute || 0);
  return money(Math.max(Number(benchmark.minimumFare || 0), fare));
};

export const createRateComparison = ({ liveProviders = [] } = {}) => ({
  async compare({
    distanceKm,
    durationMinutes,
    rateCard,
    benchmarks = [],
    route,
  }) {
    const rows = [];
    const internal = rateCard
      ? tierForDistance(rateCard.tiers, distanceKm)
      : null;
    rows.push(
      internal
        ? {
            provider: "aquakart",
            kind: "internal",
            label: rateCard.name,
            amount: money(internal.price),
            asOf: rateCard.effectiveFrom,
          }
        : {
            provider: "aquakart",
            kind: "internal",
            available: false,
            reason: "No rate card is in force",
          },
    );
    for (const benchmark of benchmarks.filter((b) => b.isActive !== false)) {
      rows.push({
        provider: benchmark.provider,
        kind: "manual_benchmark",
        label:
          benchmark.label || `${benchmark.provider} ${benchmark.vehicleType}`,
        vehicleType: benchmark.vehicleType,
        amount: benchmarkFare(benchmark, { distanceKm, durationMinutes }),
        asOf: benchmark.observedAt,
        sourceNote: benchmark.sourceNote || "",
        benchmarkId: benchmark._id,
      });
    }
    const covered = new Set(liveProviders.map((p) => p.provider));
    for (const live of liveProviders) {
      try {
        const quote = await live.quote({
          distanceKm,
          durationMinutes,
          ...route,
        });
        rows.push({
          provider: live.provider,
          kind: "live_quote",
          amount: money(quote.amount),
          asOf: new Date(),
          label: quote.label || live.provider,
        });
      } catch (error) {
        rows.push({
          provider: live.provider,
          kind: "live_quote",
          available: false,
          reason: error?.message || "Quote failed",
        });
      }
    }
    for (const provider of ["porter", "rapido"].filter((p) => !covered.has(p)))
      rows.push({
        provider,
        kind: "live_quote",
        available: false,
        reason: "No official quote integration is configured",
      });

    const internalAmount = rows[0].amount;
    return {
      distanceKm: money(distanceKm),
      durationMinutes: durationMinutes ?? null,
      informationalOnly: true,
      rows: rows.map((row) =>
        row.kind !== "internal" &&
        Number.isFinite(row.amount) &&
        Number.isFinite(internalAmount)
          ? {
              ...row,
              differenceFromInternal: money(row.amount - internalAmount),
            }
          : row,
      ),
    };
  },
});
