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
// 1.4.0: UploadThing plugin + accountRoot / showInSidebar on ResourceTypeSummary.
// 1.5.0: the cost and FinOps surface — cost reports and their folders, saved
// cost filters, scheduled report delivery, cost exports, commitments, change
// alerts, currency conversion, the cost query language, charge type and
// amortized cost basis, and Jira filing, with their permissions and tab
// targets. All additive.
export const API_VERSION = "1.5.0";
