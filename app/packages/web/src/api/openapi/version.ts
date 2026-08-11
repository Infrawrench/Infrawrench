/**
 * The published API version.
 *
 * This one number drives the entire release pipeline. It is stamped into
 * `openapi.json`, becomes the version of all nine generated SDK packages, and
 * is what CI compares against the `sdk-v*` tags to decide whether to publish.
 * **Nothing ships until it changes.**
 *
 * Bump it in the same change as any user-visible API change — a new route, a
 * changed request or response shape, a new required field, a removed one.
 * Semver is against the HTTP surface, not the server's internals:
 *
 * - **patch** — additive fixes a client cannot observe as a break
 * - **minor** — new routes, new optional fields, new enum members
 * - **major** — anything an existing client could break on
 *
 * Adding or removing a plugin changes the `pluginId` / `resourceTypeId` enums,
 * which is a real change to the published surface — that counts.
 */
// 1.7.0: new `commitment_covered_usage` member on the CostChargeType enum
// (additive enum widening, on cost queries and cost exports).
// 1.8.0: the cost and FinOps completion pass — business metrics and unit
// costs, report annotations, nested cost centres, scenario models, billing
// rules, managed accounts and invoicing; plus API-key authentication across
// the org route tree and audit entries that name the key. All additive.
// 1.9.0: invoice delivery, and commitment-expiry, idle-commitment and
// unit-cost-regression alerts (new routes, new schemas, three new alert
// trigger enum members). All additive.
// 1.10.0: network flow cost attribution, anomaly acknowledgement, and the
// Kubernetes storage / load-balancer / control-plane allocation (new routes,
// new schemas, additive fields on CostAnomaly and CostAnnotation).
export const API_VERSION = "1.10.0";
