import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type {
  components as AdminDocument,
  operations as AdminOperations,
} from "./api-types.admin.gen.js";
import type { components as AssistantDocument } from "./api-types.assistant.gen.js";
import type { components as AssistantDataDocument } from "./api-types.assistant-data.gen.js";
import type { components as ControlDocument } from "./api-types.control.gen.js";
import type { components as DataDocument } from "./api-types.data.gen.js";
import type { operations as InferenceOperations } from "./api-types.inference.gen.js";
import type { components as MetricsDocument } from "./api-types.metrics.gen.js";

/** Wire shapes from the Pinecone `2026-07` documents, named by what the plugin calls them. */

type Control = ControlDocument["schemas"];
type Admin = AdminDocument["schemas"];

type KeysOf<U> = U extends U ? keyof U : never;

/**
 * A union read as one object: every field of any member, optional. The mappers
 * read `d.cloud` and `d.pod_type` from a deployment whatever kind it turns out
 * to be, and a member without the field reads as undefined.
 */
type Across<U> = { [K in KeysOf<U>]?: U extends U ? (K extends keyof U ? U[K] : never) : never };

export type PcSchemaField = Across<Control["IndexSchemaField"]>;

type IndexModel = Control["IndexModel"];

/**
 * An index as the mappers read it: only the name is relied on, since a create
 * answered with no body falls back to the name that was asked for.
 */
export type PcIndex = Pick<IndexModel, "name"> &
  Partial<Omit<IndexModel, "name" | "status" | "deployment" | "read_capacity" | "schema">> & {
    status?: Partial<IndexModel["status"]>;
    deployment?: Across<Control["IndexDeployment"]>;
    read_capacity?: Across<Control["ReadCapacityResponse"]>;
    schema?: { fields?: Record<string, PcSchemaField> };
  };

export type PcIndexStats = DataDocument["schemas"]["IndexDescription"];

/** As {@link PcIndex}: a create answered with no body falls back to the name. */
export type PcCollection = Pick<Control["CollectionModel"], "name"> &
  Partial<Control["CollectionModel"]>;

export type PcBackup = Control["BackupModel"];
export type PcBackupSchedule = Control["BackupScheduleResponse"];
export type PcRestoreJob = Control["RestoreJobModel"];
export type PcConfigureIndex = Control["ConfigureIndexRequest"];
export type PcReadCapacity = Control["ReadCapacity"];
export type PcCreateSchemaFields = Control["CreateIndexSchema"]["fields"];
export type PcUpdateBackupSchedule = Control["UpdateBackupScheduleRequest"];

export type PcAssistant = AssistantDocument["schemas"]["Assistant"];
export type PcUpdateAssistant = AssistantDocument["schemas"]["UpdateAssistantRequest"];
export type PcAssistantFile = AssistantDataDocument["schemas"]["AssistantFileModel"];

export type PcModel = ApiListItem<InferenceOperations["list_models"], "models">;

export type PcProject = ApiListItem<AdminOperations["list_projects"], "data">;
export type PcUpdateProject = Admin["UpdateProjectRequest"];
export type PcApiKey = ApiResponse<AdminOperations["fetch_api_key"]>;
export type PcUpdateApiKey = Admin["UpdateAPIKeyRequest"];
export type PcServiceAccount = ApiListItem<AdminOperations["list_service_accounts"], "data">;

export type PcPrometheusTargets = MetricsDocument["schemas"]["PrometheusTargets"];
