/**
 * Cloud Ops API shapes, named from the generated types. The document is the
 * published OpenAPI one (`https://saas-api.tmprl.cloud/spec.json`).
 */
import type { components } from "./api-types.gen.js";

type Schemas = components["schemas"];

export type TcAccess = Schemas["v1Access"];
export type TcAccountRole = Schemas["AccountAccessRole"];
export type TcPermission = Schemas["v1NamespaceAccessPermission"];
export type TcSearchAttributeType = Schemas["NamespaceSpecSearchAttributeType"];
export type TcNamespace = Schemas["v1Namespace"];
export type TcNamespaceSpec = Schemas["v1NamespaceSpec"];
export type TcUser = Schemas["v1User"];
export type TcServiceAccount = Schemas["v1ServiceAccount"];
export type TcServiceAccountSpec = Schemas["v1ServiceAccountSpec"];
export type TcApiKey = Schemas["v1ApiKey"];
export type TcNexusEndpoint = Schemas["v1Endpoint"];
export type TcNexusEndpointSpec = Schemas["v1EndpointSpec"];
export type TcExportSink = Schemas["v1ExportSink"];
export type TcExportSinkSpec = Schemas["v1ExportSinkSpec"];
export type TcConnectivityRule = Schemas["v1ConnectivityRule"];
export type TcConnectivityRuleSpec = Schemas["v1ConnectivityRuleSpec"];
export type TcRegion = Schemas["v1Region"];
export type TcAccount = Schemas["v1Account"];
export type TcCapacityInfo = Schemas["v1NamespaceCapacityInfo"];
export type TcBillingReport = Schemas["v1BillingReport"];
export type TcUsageSummary = Schemas["usagev1Summary"];
