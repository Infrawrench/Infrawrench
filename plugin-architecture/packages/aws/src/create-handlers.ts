import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type {
  AwsCreateContext,
  GetConfigHandler,
  CreateHandler,
} from "./create-handlers/shared.js";
import { computeGetCreateConfig, computeCreateResource } from "./create-handlers/compute.js";
import {
  networkingGetCreateConfig,
  networkingCreateResource,
} from "./create-handlers/networking.js";
import { storageGetCreateConfig, storageCreateResource } from "./create-handlers/storage.js";
import { databaseGetCreateConfig, databaseCreateResource } from "./create-handlers/database.js";
import { messagingGetCreateConfig, messagingCreateResource } from "./create-handlers/messaging.js";
import { iamGetCreateConfig, iamCreateResource } from "./create-handlers/iam.js";
import {
  observabilityGetCreateConfig,
  observabilityCreateResource,
} from "./create-handlers/observability.js";
import {
  managementGetCreateConfig,
  managementCreateResource,
} from "./create-handlers/management.js";

export type { AwsCreateContext } from "./create-handlers/shared.js";

const getConfigHandlers: GetConfigHandler[] = [
  computeGetCreateConfig,
  networkingGetCreateConfig,
  storageGetCreateConfig,
  databaseGetCreateConfig,
  messagingGetCreateConfig,
  iamGetCreateConfig,
  observabilityGetCreateConfig,
  managementGetCreateConfig,
];

const createHandlers: CreateHandler[] = [
  computeCreateResource,
  networkingCreateResource,
  storageCreateResource,
  databaseCreateResource,
  messagingCreateResource,
  iamCreateResource,
  observabilityCreateResource,
  managementCreateResource,
];

export async function awsGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  for (const handler of getConfigHandlers) {
    const result = await handler(ctx, typeId, parentResourceId);
    if (result !== null) return result;
  }
  throw new Error(`AWS plugin: getCreateConfig not supported for type "${typeId}"`);
}

export async function awsCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  for (const handler of createHandlers) {
    const result = await handler(ctx, typeId, accountId, fields, parentResourceId);
    if (result !== null) return result;
  }
  throw new Error(`AWS plugin: createResource not supported for type "${typeId}"`);
}
