import { RoutingError } from "./errors.js";
import { createGoogleMapsProvider } from "./googleMaps.js";
import { createOsmProvider } from "./osm.js";

// Routing provider interface (road distance, never straight-line):
//
//   provider.name
//   provider.geocode(address, { near }) ->
//     { status: "ok", match: Place } |
//     { status: "ambiguous", candidates: Place[] } |
//     { status: "not_found" }
//     Place = { formattedAddress, lat, lng, placeId, precision }
//   provider.route(origin, destination) ->
//     { distanceMeters, durationSeconds, polyline }
//
// Errors are RoutingError. Choose the provider with TRANSIT_ROUTING_PROVIDER:
//   "osm" (default)  keyless OpenStreetMap: Nominatim + OSRM (osm.js)
//   "google"         Google Geocoding + Routes, needs GOOGLE_MAPS_API_KEY
// Another provider only has to implement the two calls.

export { RoutingError };

export const DEFAULT_ROUTING_PROVIDER = "osm";

const unavailable = (name, reason) => {
  const fail = async () => {
    throw new RoutingError(503, "ROUTING_NOT_CONFIGURED", reason);
  };
  return { name, configured: false, geocode: fail, route: fail };
};

const PROVIDERS = {
  osm: (env) =>
    createOsmProvider({
      ...(env.TRANSIT_NOMINATIM_URL
        ? { nominatimUrl: env.TRANSIT_NOMINATIM_URL }
        : {}),
      ...(env.TRANSIT_OSRM_URL ? { osrmUrl: env.TRANSIT_OSRM_URL } : {}),
      ...(env.TRANSIT_OSM_USER_AGENT
        ? { userAgent: env.TRANSIT_OSM_USER_AGENT }
        : {}),
    }),
  google: (env) =>
    env.GOOGLE_MAPS_API_KEY
      ? createGoogleMapsProvider({ apiKey: env.GOOGLE_MAPS_API_KEY })
      : unavailable(
          "google",
          "Distance calculation is not configured (GOOGLE_MAPS_API_KEY is missing)",
        ),
};

/** The configured provider. Read at call time so runtime config applies. */
export const routingProvider = (env = process.env) => {
  const name = String(
    env.TRANSIT_ROUTING_PROVIDER || DEFAULT_ROUTING_PROVIDER,
  ).toLowerCase();
  const factory = PROVIDERS[name];
  return factory
    ? factory(env)
    : unavailable(name, `Unknown routing provider "${name}"`);
};

/** Delegates every call to the provider configured at that moment. */
export const runtimeRouting = {
  get name() {
    return routingProvider().name;
  },
  geocode: (...args) => routingProvider().geocode(...args),
  route: (...args) => routingProvider().route(...args),
};
