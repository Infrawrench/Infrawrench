/**
 * Axiom's API objects, named from its published OpenAPI documents
 * (axiomhq/docs `content/docs/(api-reference)/restapi/versions/`). Nothing checks
 * them at runtime, so the mappers take them `Partial` and survive a partial body.
 */
import type { ApiResponse } from "@infrawrench/plugin-base";
import type { components, operations } from "./api-types.v2.gen.js";

export type AxOrg = ApiResponse<operations["getOrg"]>;
export type AxDataset = ApiResponse<operations["getDataset"]>;
export type AxField = ApiResponse<operations["getFieldForDataset"]>;
export type AxVirtualField = ApiResponse<operations["getVirtualField"]>;
export type AxMonitor = ApiResponse<operations["getMonitor"]>;
export type AxNotifier = ApiResponse<operations["getNotifier"]>;
/** A notifier as `GET /notifiers` lists it. */
export type AxNotifierRow = ApiResponse<operations["getNotifiers"]>[number];
export type AxNotifierProperties = components["schemas"]["NotifierProperties"];
export type AxDashboard = ApiResponse<operations["getDashboard"]>;
/** The document does not list `id` on a view, and the plugin reads it where one comes back. */
export type AxView = ApiResponse<operations["getView"]> & { id?: string };
export type AxStarredQuery = ApiResponse<operations["getStarred"]>;
export type AxAnnotation = ApiResponse<operations["getAnnotation"]>;
/** Only a created or regenerated token has its `token`. */
export type AxToken = ApiResponse<operations["createAPIToken"]>;
export type AxUser = ApiResponse<operations["getUser"]>;
export type AxDatasetCapability = components["schemas"]["datasetCapabilities"][string];

/** A set of capabilities, read generically to print them. */
export type AxCapabilities = Record<string, readonly string[] | undefined>;
