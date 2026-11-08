/**
 * Scaleway availability zones and regions. Milan (`it-mil`, zone
 * `it-mil-1`) opened on 2026-03-10; not every product is offered there, and
 * the listers skip a location that refuses a request.
 *
 * Zones differ per product, so each zonal product reads the list its own
 * Scaleway SDK API names (`LOCALITY` in `packages_generated/<product>/src/<version>/api.gen.ts`
 * on scaleway-sdk-js). A zone is added to a product here only once that list has it:
 * what an API answers in a zone it does not serve is not documented, and a 5xx there
 * would fail the type for every account (#771).
 */

/** Instances, their flexible IPs, load balancers and the instance price catalog. */
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
];

/**
 * Block Storage. Its API lists MIL-2 and MIL-3, opened in October 2026; the Instance
 * API still lists only `it-mil-1`.
 */
export const SCW_BLOCK_ZONES = [...SCW_ZONES, "it-mil-2", "it-mil-3"];

export const SCW_REGIONS = ["fr-par", "nl-ams", "pl-waw", "it-mil"];
