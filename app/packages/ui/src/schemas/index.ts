/**
 * Effect schemas shared by the UI, the web API and the desktop app: request
 * bodies as the forms validate them and the API decodes them, with the
 * OpenAPI names and descriptions the API documents them under.
 *
 * React-free, its own build entry (`@infrawrench/ui/schemas`), so the server
 * can import it without the component barrel.
 */
export * from "./alert-email";
export * from "./billing-rules";
export * from "./budgets";
export * from "./business-metrics";
export * from "./checks";
export * from "./cost-alerts";
export * from "./cost-annotations";
export * from "./cost-anomalies";
export * from "./cost-canvases";
export * from "./cost-centres";
export * from "./cost-enums";
export * from "./cost-filter";
export * from "./cost-forecasts";
export * from "./cost-graph";
export * from "./cost-query";
export * from "./cost-reports";
export * from "./cost-scenarios";
export * from "./currency";
export * from "./form";
export * from "./invoices";
export * from "./k8s-efficiency";
export * from "./metric-alerts";
export * from "./primitives";
export * from "./resource-reports";
export * from "./saved-filters";
export * from "./savings";
export * from "./tags";
export * from "./unit-costs";
export * from "./virtual-tags";
export * from "./widgets";
