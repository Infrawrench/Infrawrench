/**
 * Ephemeral environments — capture a set of existing resources as a
 * parameterised template, stamp copies of it out on demand, and have each copy
 * delete itself when its TTL runs out.
 *
 * This module is the shared pure half: the wire contract for
 * `/api/org/:orgId/environments`, the template document model, and every piece
 * of judgement that decides what an instantiation actually does — dependency
 * ordering, parameter substitution, output-reference rewriting and name
 * prefixing. None of it touches a database, a provider API or a plugin, which
 * is what lets the same functions run in the API handler, the editor UI and the
 * unit tests.
 *
 * **Nothing here knows what a provider is.** A template is built from each
 * plugin's own create-field metadata (`getCreateConfig`), so the set of fields
 * that can be captured, varied or prefixed is whatever the plugin says its
 * create form takes. The host never special-cases a `pluginId`.
 *
 * Split by concern: `types` (wire contract + limits), `template` (naming,
 * ordering, validation, TTL rails), `instantiate` (plan + field resolution),
 * `teardown` (failure bookkeeping, lease repair, the identity rule),
 * `capture` (draft building + parameter suggestion), `display`, and `api`
 * (bearer fetch wrappers).
 */
export * from "./types";
export * from "./template";
export * from "./instantiate";
export * from "./teardown";
export * from "./capture";
export * from "./display";
export * from "./api";
