import axios from "axios";
import { RoutingError } from "./errors.js";

// Google Maps Platform: Geocoding API for the address and Routes API
// (computeRoutes, DRIVE) for road distance. The key is sent in a header for
// Routes and as the documented `key` parameter for Geocoding; it is never
// logged or returned.

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const TIMEOUT_MS = 15_000;
// Results further apart than this are different places.
const SAME_PLACE_METERS = 300;
// Bias geocoding to this distance around the warehouse.
const BIAS_KM = 60;

// Precise enough to drive to. Anything coarser (a locality, a pincode, the
// middle of a road) is ambiguous: the transporter must pin the location.
const PRECISE_TYPES = new Set([
  "street_address",
  "premise",
  "subpremise",
  "establishment",
  "point_of_interest",
]);

export const metersBetween = (a, b) => {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

const place = (result) => ({
  formattedAddress: result.formatted_address || "",
  lat: result.geometry?.location?.lat,
  lng: result.geometry?.location?.lng,
  placeId: result.place_id || "",
  precision: result.geometry?.location_type || "",
  types: Array.isArray(result.types) ? result.types : [],
});

const isPrecise = (result) =>
  !result.partial_match &&
  (["ROOFTOP", "RANGE_INTERPOLATED"].includes(result.geometry?.location_type) ||
    (result.types || []).some((type) => PRECISE_TYPES.has(type)));

/** Classifies Geocoding API results (exported for tests). */
export const classifyGeocode = (results = []) => {
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

const bounds = (near) => {
  const dLat = BIAS_KM / 111;
  const dLng = BIAS_KM / (111 * Math.cos((near.lat * Math.PI) / 180));
  return `${near.lat - dLat},${near.lng - dLng}|${near.lat + dLat},${near.lng + dLng}`;
};

const providerError = (error, what) => {
  if (error instanceof RoutingError) return error;
  return new RoutingError(
    502,
    "ROUTING_PROVIDER_ERROR",
    `Google Maps could not ${what}. Try again, or pin the location.`,
    { providerStatus: error?.response?.status || error?.code || null },
  );
};

export const createGoogleMapsProvider = ({ apiKey, http = axios }) => ({
  name: "google",
  configured: true,

  async geocode(address, { near } = {}) {
    let data;
    try {
      ({ data } = await http.get(GEOCODE_URL, {
        params: {
          address,
          components: "country:IN",
          region: "in",
          ...(near ? { bounds: bounds(near) } : {}),
          key: apiKey,
        },
        timeout: TIMEOUT_MS,
      }));
    } catch (error) {
      throw providerError(error, "look up the address");
    }
    if (data?.status === "ZERO_RESULTS") return { status: "not_found" };
    if (data?.status !== "OK")
      throw new RoutingError(
        502,
        "ROUTING_PROVIDER_ERROR",
        "Google Maps could not look up the address",
        { providerStatus: data?.status || null },
      );
    return classifyGeocode(data.results);
  },

  async route(origin, destination) {
    let data;
    const latLng = (p) => ({
      location: { latLng: { latitude: p.lat, longitude: p.lng } },
    });
    try {
      ({ data } = await http.post(
        ROUTES_URL,
        {
          origin: latLng(origin),
          destination: latLng(destination),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          units: "METRIC",
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask":
              "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
          },
          timeout: TIMEOUT_MS,
        },
      ));
    } catch (error) {
      throw providerError(error, "calculate the route");
    }
    const route = data?.routes?.[0];
    const distanceMeters = Number(route?.distanceMeters);
    if (!route || !Number.isFinite(distanceMeters) || distanceMeters < 0)
      throw new RoutingError(
        422,
        "ROUTE_NOT_FOUND",
        "No road route was found from the warehouse to this location",
      );
    const seconds = Number(String(route.duration || "").replace(/s$/, ""));
    return {
      distanceMeters,
      durationSeconds: Number.isFinite(seconds) ? seconds : null,
      polyline: route.polyline?.encodedPolyline || "",
    };
  },
});
