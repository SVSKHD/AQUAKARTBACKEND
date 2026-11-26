import axios from "axios";
import { RoutingError } from "./errors.js";
import { metersBetween } from "./googleMaps.js";

// Keyless routing on OpenStreetMap data: Nominatim for the address and OSRM
// (car profile) for road distance. No API key or account is needed.
//
// Both public servers are run by volunteers under fair-use policies, with no
// uptime guarantee:
//   - Nominatim: at most 1 request per second, with an identifying
//     User-Agent (https://operations.osmfoundation.org/policies/nominatim/).
//   - routing.openstreetmap.de (FOSSGIS OSRM): light use, no bulk requests.
// Point TRANSIT_NOMINATIM_URL / TRANSIT_OSRM_URL at self-hosted instances if
// volume grows. A provider failure blocks pricing; no distance is guessed.

export const DEFAULT_NOMINATIM_URL = "https://nominatim.openstreetmap.org";
export const DEFAULT_OSRM_URL = "https://routing.openstreetmap.de/routed-car";
export const DEFAULT_USER_AGENT =
  "AquakartTransit/1.0 (+https://aquakart.co.in)";

const TIMEOUT_MS = 15_000;
// Results further apart than this are different places.
const SAME_PLACE_METERS = 300;
// Bias geocoding to this distance around the warehouse.
const BIAS_KM = 60;
// Nominatim allows one request per second.
const NOMINATIM_INTERVAL_MS = 1_100;
// OSRM snaps each end to the nearest road. Further than this from a road, the
// unrouted stretch would be missing from the distance, so the route is refused.
const MAX_SNAP_METERS = 500;
// Nominatim place_rank: 30 = house, building or point of interest, 28 = house
// numbers / addressable places. Lower ranks (streets, localities, pincodes)
// are not precise enough to drive to.
const PRECISE_RANK = 28;

// One queue per process: the provider object is rebuilt on every call.
let nominatimQueue = Promise.resolve();
let lastNominatimAt = 0;
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const throttled = (fn, { wait, clock }) => {
  const run = nominatimQueue.then(async () => {
    const gap = lastNominatimAt + NOMINATIM_INTERVAL_MS - clock();
    if (gap > 0) await wait(gap);
    lastNominatimAt = clock();
    return fn();
  });
  // Keep the queue alive after a failure.
  nominatimQueue = run.catch(() => {});
  return run;
};

/** Test hook: forget the last request time. */
export const resetNominatimThrottle = () => {
  nominatimQueue = Promise.resolve();
  lastNominatimAt = 0;
};

const place = (result) => ({
  formattedAddress: result.display_name || "",
  lat: Number(result.lat),
  lng: Number(result.lon),
  placeId:
    result.osm_type && result.osm_id
      ? `osm:${result.osm_type}/${result.osm_id}`
      : String(result.place_id || ""),
  precision: `rank:${Number(result.place_rank) || 0}`,
});

const isPrecise = (result) => Number(result.place_rank) >= PRECISE_RANK;

/** Classifies Nominatim search results (exported for tests). */
export const classifyNominatim = (results = []) => {
  const places = results
    .map((result) => ({ result, place: place(result) }))
    .filter(({ place: p }) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!places.length) return { status: "not_found" };
  const [first] = places;
  const distinct = places.filter(
    ({ place: p }) => metersBetween(first.place, p) > SAME_PLACE_METERS,
  );
  if (distinct.length || !isPrecise(first.result))
    return {
      status: "ambiguous",
      candidates: places.slice(0, 5).map(({ place: p }) => p),
    };
  return { status: "ok", match: first.place };
};

// Nominatim viewbox: left,top,right,bottom (lng,lat,lng,lat).
const viewbox = (near) => {
  const dLat = BIAS_KM / 111;
  const dLng = BIAS_KM / (111 * Math.cos((near.lat * Math.PI) / 180));
  return [
    near.lng - dLng,
    near.lat + dLat,
    near.lng + dLng,
    near.lat - dLat,
  ].join(",");
};

const providerError = (error, what) => {
  if (error instanceof RoutingError) return error;
  return new RoutingError(
    502,
    "ROUTING_PROVIDER_ERROR",
    `The map service could not ${what}. Try again, or pin the location.`,
    { providerStatus: error?.response?.status || error?.code || null },
  );
};

const trimSlash = (url) => String(url).replace(/\/+$/, "");
const coord = (n) => Number(n).toFixed(6);

export const createOsmProvider = ({
  nominatimUrl = DEFAULT_NOMINATIM_URL,
  osrmUrl = DEFAULT_OSRM_URL,
  userAgent = DEFAULT_USER_AGENT,
  http = axios,
  wait = defaultWait,
  clock = Date.now,
} = {}) => ({
  name: "osm",
  configured: true,

  async geocode(address, { near } = {}) {
    let data;
    try {
      ({ data } = await throttled(
        () =>
          http.get(`${trimSlash(nominatimUrl)}/search`, {
            params: {
              q: address,
              format: "jsonv2",
              countrycodes: "in",
              limit: 5,
              ...(near ? { viewbox: viewbox(near), bounded: 0 } : {}),
            },
            headers: { "User-Agent": userAgent, "Accept-Language": "en" },
            timeout: TIMEOUT_MS,
          }),
        { wait, clock },
      ));
    } catch (error) {
      throw providerError(error, "look up the address");
    }
    if (!Array.isArray(data))
      throw new RoutingError(
        502,
        "ROUTING_PROVIDER_ERROR",
        "The map service could not look up the address",
      );
    return classifyNominatim(data);
  },

  async route(origin, destination) {
    let data;
    const points = [origin, destination]
      .map((p) => `${coord(p.lng)},${coord(p.lat)}`)
      .join(";");
    try {
      ({ data } = await http.get(
        `${trimSlash(osrmUrl)}/route/v1/driving/${points}`,
        {
          params: { overview: "full", geometries: "polyline", steps: false },
          headers: { "User-Agent": userAgent },
          timeout: TIMEOUT_MS,
          // OSRM answers "no route" with a 400 and a JSON body.
          validateStatus: (status) => status < 500,
        },
      ));
    } catch (error) {
      throw providerError(error, "calculate the route");
    }
    const route = data?.routes?.[0];
    const distanceMeters = Number(route?.distance);
    if (
      data?.code !== "Ok" ||
      !route ||
      !Number.isFinite(distanceMeters) ||
      distanceMeters < 0
    ) {
      if (data?.code && !["NoRoute", "NoSegment", "Ok"].includes(data.code))
        throw new RoutingError(
          502,
          "ROUTING_PROVIDER_ERROR",
          "The map service could not calculate the route. Try again.",
          { providerStatus: data.code },
        );
      throw new RoutingError(
        422,
        "ROUTE_NOT_FOUND",
        "No road route was found from the warehouse to this location",
      );
    }
    const snapped = (data.waypoints || []).map((w) => Number(w?.distance) || 0);
    if (snapped.some((m) => m > MAX_SNAP_METERS))
      throw new RoutingError(
        422,
        "ROUTE_NOT_FOUND",
        "The location is too far from a mapped road to measure the distance. Pin the location on or next to the road.",
        { snapMeters: snapped.map((m) => Math.round(m)) },
      );
    const seconds = Number(route.duration);
    return {
      distanceMeters,
      durationSeconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      polyline: typeof route.geometry === "string" ? route.geometry : "",
    };
  },
});
