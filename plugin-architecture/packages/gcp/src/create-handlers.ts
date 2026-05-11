import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpCreateContext } from "./create-context.js";
export type { GcpCreateContext } from "./create-context.js";
import {
  computeEngineCreateConfigHandlers,
  computeEngineCreateResourceHandlers,
} from "./compute-engine-create-handlers.js";
import { gkeCreateConfigHandlers, gkeCreateResourceHandlers } from "./gke-create-handlers.js";
import {
  storageCreateConfigHandlers,
  storageCreateResourceHandlers,
} from "./storage-create-handlers.js";
import {
  cloudsqlCreateConfigHandlers,
  cloudsqlCreateResourceHandlers,
} from "./cloudsql-create-handlers.js";
import {
  alloydbCreateConfigHandlers,
  alloydbCreateResourceHandlers,
} from "./alloydb-create-handlers.js";
import {
  pubsubCreateConfigHandlers,
  pubsubCreateResourceHandlers,
} from "./pubsub-create-handlers.js";
import {
  tasksSchedulerCreateConfigHandlers,
  tasksSchedulerCreateResourceHandlers,
} from "./tasks-scheduler-create-handlers.js";
import { dnsCreateConfigHandlers, dnsCreateResourceHandlers } from "./dns-create-handlers.js";
import {
  securityCreateConfigHandlers,
  securityCreateResourceHandlers,
} from "./security-create-handlers.js";
import {
  networkingCreateConfigHandlers,
  networkingCreateResourceHandlers,
} from "./networking-create-handlers.js";
import {
  observabilityCreateConfigHandlers,
  observabilityCreateResourceHandlers,
} from "./observability-create-handlers.js";
import {
  firestoreCreateConfigHandlers,
  firestoreCreateResourceHandlers,
} from "./firestore-create-handlers.js";
import {
  memorystoreCreateConfigHandlers,
  memorystoreCreateResourceHandlers,
} from "./memorystore-create-handlers.js";
import {
  bigqueryCreateConfigHandlers,
  bigqueryCreateResourceHandlers,
} from "./bigquery-create-handlers.js";
import {
  spannerCreateConfigHandlers,
  spannerCreateResourceHandlers,
} from "./spanner-create-handlers.js";
import {
  bigtableCreateConfigHandlers,
  bigtableCreateResourceHandlers,
} from "./bigtable-create-handlers.js";
import {
  cloudRunCreateConfigHandlers,
  cloudRunCreateResourceHandlers,
} from "./cloud-run-create-handlers.js";
import {
  cloudArmorCreateConfigHandlers,
  cloudArmorCreateResourceHandlers,
} from "./cloud-armor-create-handlers.js";
import {
  cloudBuildCreateConfigHandlers,
  cloudBuildCreateResourceHandlers,
} from "./cloud-build-create-handlers.js";
import {
  cloudFunctionsCreateConfigHandlers,
  cloudFunctionsCreateResourceHandlers,
} from "./cloud-functions-create-handlers.js";

const createConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  ...computeEngineCreateConfigHandlers,
  ...gkeCreateConfigHandlers,
  ...storageCreateConfigHandlers,
  ...cloudsqlCreateConfigHandlers,
  ...alloydbCreateConfigHandlers,
  ...pubsubCreateConfigHandlers,
  ...tasksSchedulerCreateConfigHandlers,
  ...dnsCreateConfigHandlers,
  ...securityCreateConfigHandlers,
  ...networkingCreateConfigHandlers,
  ...observabilityCreateConfigHandlers,
  ...firestoreCreateConfigHandlers,
  ...memorystoreCreateConfigHandlers,
  ...bigqueryCreateConfigHandlers,
  ...spannerCreateConfigHandlers,
  ...bigtableCreateConfigHandlers,
  ...cloudRunCreateConfigHandlers,
  ...cloudArmorCreateConfigHandlers,
  ...cloudBuildCreateConfigHandlers,
  ...cloudFunctionsCreateConfigHandlers,
};

const createResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  ...computeEngineCreateResourceHandlers,
  ...gkeCreateResourceHandlers,
  ...storageCreateResourceHandlers,
  ...cloudsqlCreateResourceHandlers,
  ...alloydbCreateResourceHandlers,
  ...pubsubCreateResourceHandlers,
  ...tasksSchedulerCreateResourceHandlers,
  ...dnsCreateResourceHandlers,
  ...securityCreateResourceHandlers,
  ...networkingCreateResourceHandlers,
  ...observabilityCreateResourceHandlers,
  ...firestoreCreateResourceHandlers,
  ...memorystoreCreateResourceHandlers,
  ...bigqueryCreateResourceHandlers,
  ...spannerCreateResourceHandlers,
  ...bigtableCreateResourceHandlers,
  ...cloudRunCreateResourceHandlers,
  ...cloudArmorCreateResourceHandlers,
  ...cloudBuildCreateResourceHandlers,
  ...cloudFunctionsCreateResourceHandlers,
};

export async function gcpGetCreateConfig(
  ctx: GcpCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const handler = createConfigHandlers[typeId];
  if (!handler) {
    throw new Error(`No create config for type "${typeId}"`);
  }
  return handler(ctx, parentResourceId);
}

export async function gcpCreateResource(
  ctx: GcpCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const handler = createResourceHandlers[typeId];
  if (!handler) {
    throw new Error(`GCP plugin: createResource not supported for type "${typeId}"`);
  }
  return handler(ctx, accountId, fields, parentResourceId);
}
