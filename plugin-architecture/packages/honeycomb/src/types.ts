/**
 * Wire types for the Honeycomb API, generated from Honeycomb's published OpenAPI
 * document (see `plugingen.json`). A few say more than the document does: where a
 * response is a union whose members hold different fields, the mappers read a field
 * whichever member they have, and listers must survive partial bodies, so `?.` and
 * `??` stay even on what the document calls required.
 */
import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type {
  components as ConfigComponents,
  operations as ConfigOperations,
} from "./api-types.config.gen.js";
import type { operations as ManagementOperations } from "./api-types.management.gen.js";

type Schema = ConfigComponents["schemas"];

export type HnyAuth = ApiResponse<ConfigOperations["getAuth"]>;
export type HnyAuthV2 = ApiResponse<ManagementOperations["getV2Auth"]>;

export type HnyEnvironment = ApiListItem<ManagementOperations["listEnvironments"], "data">;
export type HnyEnvironmentAttrs = HnyEnvironment["attributes"];

/** One view of a key across its list rows, its single read and its create answer. */
export interface HnyApiKey {
  id: string;
  attributes?: HnyApiKeyAttrs;
  relationships?: { environment?: { data?: { id?: string } | null } };
}

export interface HnyApiKeyAttrs {
  name?: string;
  key_type?: string;
  disabled?: boolean;
  secret?: string;
  permissions?: Record<string, boolean | undefined>;
  timestamps?: { created?: string; updated?: string };
}

export type HnyDataset = Schema["Dataset"];
export type HnyDatasetDefinitions = Schema["DatasetDefinitions"];
export type HnyColumn = Schema["Column"];
export type HnyDerivedColumn = Schema["CalculatedField"];
export type HnyTag = Schema["Tag"];
export type HnyNotificationRecipient = Schema["NotificationRecipient"];
export type HnyQuerySpec = Schema["Query"];
export type HnyFilter = NonNullable<HnyQuerySpec["filters"]>[number];
export type HnyTrigger = Schema["TriggerResponse"];
/** A plain SLO is one of these with the Enterprise-only fields missing. */
export type HnySlo = Schema["SLODetailedResponse"];

/** A list row or a single read, of either kind of alert. */
export type HnyBurnAlert = Schema["BurnAlertListResponse"] & {
  exhaustion_minutes?: number;
  budget_rate_window_minutes?: number;
  budget_rate_decrease_threshold_per_million?: number;
  recipients?: HnyNotificationRecipient[];
};

export type HnyBoard = Schema["Board"];
export type HnyBoardView = Schema["BoardViewResponse"];
export type HnyMarker = Schema["Marker"];
export type HnyMarkerSetting = Schema["MarkerSetting"];

type PagerDutyDetails = NonNullable<Schema["PagerDutyRecipient"]["details"]>;
type WebhookDetails = NonNullable<Schema["WebhookRecipient"]["details"]>;

export type HnyRecipientDetails = Partial<PagerDutyDetails> &
  Partial<WebhookDetails> & { email_address?: string; slack_channel?: string };

/** A recipient of any type, with `details` readable without asking which. */
export type HnyRecipient = Schema["Recipient"] & { details?: HnyRecipientDetails };

export type HnyQueryAnnotation = Schema["QueryAnnotation"];
export type HnySignal = Schema["Signal"];
export type HnyQueryResult = Schema["QueryResultDetails"];
export type HnySloHistory = Schema["SLOHourlyCountsResponse"];
