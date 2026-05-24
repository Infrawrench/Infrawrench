/**
 * Aggregate re-export of the cloud Tauri-bridge API.
 *
 * The original `cloud-api.ts` accumulated 60+ unrelated `invoke()` wrappers
 * (auth, accounts, dashboards, resources, secrets, SQL, KV, SFTP, SSH). It has
 * been split into focused modules by API surface. Importers of `cloud-api`
 * keep working unchanged through this barrel; new code may import the focused
 * module directly.
 */
export * from "./cloud-auth";
export * from "./cloud-accounts";
export * from "./cloud-dashboards";
export * from "./cloud-resources";
export * from "./cloud-secrets";
export * from "./cloud-sql";
export * from "./cloud-sftp";
