/**
 * Scaleway availability zones and regions. Milan (`it-mil`, zone
 * `it-mil-1`) opened on 2026-03-10; not every product is offered there, and
 * the listers skip a location that refuses a request.
 *
 * Zones differ per product, so each zonal product reads the list its own
 * Scaleway SDK API names (`LOCALITY` in `packages_generated/<product>/src/<version>/api.gen.ts`
 * on scaleway-sdk-js), or a zone Scaleway's API gateway is shown to route for it.
 * The gateway answers a product it does not run in a zone with `501 unknown service`
 * before checking the key (bare metal or Apple silicon in `it-mil-2`, the LB API in
 * `fr-par-3`), which the listers read as a refusal; a routed one asks for the key.
 */

/**
 * Instances, their flexible IPs, load balancers and the instance price catalog.
 *
 * MIL-2 and MIL-3 opened in October 2026 (Scaleway's changelog lists Instances
 * there). The Instance v1 SDK's `LOCALITY` still has only `it-mil-1`, but the
 * Instance API serves both zones (#771, checked 2026-11-15): the public
 * `GET /instance/v1/zones/it-mil-2/products/servers` (and `it-mil-3`) answers 200
 * with available server types, and `/servers` and `/ips` there ask for a key
 * rather than answering `501 unknown service`. The v2alpha1 SDK lists both.
 */
export const SCW_ZONES = [
  "fr-par-1",
  "fr-par-2",
  "fr-par-3",
  "nl-ams-1",
  "nl-ams-2",
  "nl-ams-3",
  "pl-waw-1",
  "pl-waw-2",
  "pl-waw-3",
  "it-mil-1",
  "it-mil-2",
  "it-mil-3",
];

/** Block Storage. Its SDK API lists the same zones, MIL-2 and MIL-3 included. */
export const SCW_BLOCK_ZONES = [...SCW_ZONES];

export const SCW_REGIONS = ["fr-par", "nl-ams", "pl-waw", "it-mil"];
