export type { AwsCreateContext, GetConfigHandler, CreateHandler } from "./shared.js";
export { computeGetCreateConfig, computeCreateResource } from "./compute.js";
export { networkingGetCreateConfig, networkingCreateResource } from "./networking.js";
export { storageGetCreateConfig, storageCreateResource } from "./storage.js";
export { databaseGetCreateConfig, databaseCreateResource } from "./database.js";
export { messagingGetCreateConfig, messagingCreateResource } from "./messaging.js";
export { iamGetCreateConfig, iamCreateResource } from "./iam.js";
export { observabilityGetCreateConfig, observabilityCreateResource } from "./observability.js";
export { managementGetCreateConfig, managementCreateResource } from "./management.js";
