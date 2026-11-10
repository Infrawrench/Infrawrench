/**
 * The contract domains the desktop calls through its cloud transport, by the
 * name the renderer asks for them with (`cloudClient("probes")`).
 *
 * One list for both ends. The renderer derives its typed client from an
 * entry (`src/lib/cloud-client.ts`), and the main process derives its
 * allowlist from every endpoint of every entry (`electron/cloud-allowlist.ts`),
 * so a domain without an entry cannot be called by name, and a request built
 * for it by hand is refused before it leaves the main process. Migrating a
 * `cloud-data/<area>.ts` file adds its domain here; KNOWLEDGE.md ("Desktop
 * IPC on Effect RPC") has the recipe.
 */
import { Predicate, Schema, SchemaAST, type Context } from "effect";
import {
  HttpApi,
  HttpApiSchema,
  type HttpApiEndpoint,
  type HttpApiGroup,
  type HttpApiMiddleware,
} from "effect/http-api";
import { OrgAuth, SessionAuth } from "@infrawrench/api-contract";
import {
  AccountsApi,
  AgentsApi,
  ChatApi,
  ComplianceApi,
  ConnectionsApi,
  DeploymentsApi,
  EnvironmentsApi,
  IncidentsApi,
  KubernetesEfficiencyReportsApi,
  PagingProvidersApi,
  ProbesApi,
  ResourceReportsApi,
  SlosApi,
} from "@infrawrench/api-contract";
import {
  AccessReviewApi,
  CalendarApi,
  DnsApi,
  EnvironmentDiffApi,
  ExpiringApi,
  ExtendedSupportApi,
  IdleFindingsApi,
  LeakedSecretsApi,
  MomentApi,
  OrphansApi,
  OwnershipApi,
  PostureApi,
  PriceCatalogApi,
  QuotasApi,
  ResourcesApi,
  RightsizingApi,
  SearchApi,
  SeatsApi,
  SshFanoutApi,
  SshTunnelsApi,
  StarredApi,
  VulnerabilitiesApi,
  WallboardApi,
} from "@infrawrench/api-contract";
import {
  BillingProfilesApi,
  BillingRulesApi,
  BlastRadiusApi,
  CostCanvasesApi,
  CostCentresApi,
  DashboardsApi,
  DependencyGraphApi,
  GithubApi,
  InvoicesApi,
  OnCallApi,
  ScorecardsApi,
  ServicesApi,
  SshKeysApi,
  TagKeysApi,
  VirtualTagsApi,
  WorkflowApprovalsApi,
  WorkflowSecretsApi,
  WorkflowsApi,
} from "@infrawrench/api-contract";
import {
  BackupsApi,
  CostAnnotationsApi,
  CustomGraphsApi,
  CiApi,
  DoraApi,
  IacApi,
  OrgFeaturesApi,
  ProductsApi,
  LeasesApi,
  LogWorkspacesApi,
  MetricAlertsApi,
  NetworkFlowsApi,
  QueryMonitorsApi,
  ResourceChangesApi,
  RunbooksApi,
  SavingsFindingsApi,
  SchedulesApi,
  StatusIncidentsApi,
  StatusPagesApi,
} from "@infrawrench/api-contract";
import {
  AlertEmailApi,
  BudgetsApi,
  BusinessMetricsApi,
  CarbonApi,
  CommitmentsApi,
  CostAlertsApi,
  CostAnomalyFeedbackApi,
  CostExportJobsApi,
  CostReportAnomalyAlertsApi,
  CostReportFoldersApi,
  CostReportNotificationsApi,
  CostReportsApi,
  CostScenariosApi,
  CostsApi,
  CreditsApi,
  DashboardNotificationsApi,
  SavedCostFiltersApi,
  SavingsApi,
  TagPolicyApi,
} from "@infrawrench/api-contract";

/**
 * How an endpoint answers, from the success schemas it declares:
 *
 * - `json`: every success is JSON (or no body); the client parses it.
 * - `text`: a success is text (`HttpApiSchema.asText`: CSV, typings); the
 *   client hands the body on as the server sent it, a JSON alternative
 *   included (the access-review export answers either).
 * - `bytes`: a success is binary (`asUint8Array`: a PDF, a ZIP); it crosses
 *   on `CloudHttpBytes`.
 * - `stream`: an SSE, NDJSON or byte stream, or a protocol upgrade. A
 *   buffered transport would hold the stream until it ended, so the
 *   allowlist refuses these and the client has no method for them.
 */
export type DesktopCloudAnswer = "json" | "text" | "bytes" | "stream";

/** One endpoint of a registered domain, as `HttpApi.reflect` walks it. */
export interface DesktopCloudEndpoint {
  readonly group: string;
  readonly endpoint: HttpApiEndpoint.Top;
  /** The API's, group's and endpoint's annotations merged (parse options live here). */
  readonly annotations: Context.Context<never>;
  /**
   * Whether the endpoint runs the contract's `OrgAuth` or `SessionAuth`
   * middleware, so the server reads the bearer token the transport attaches
   * as the caller's session. A webhook or a public page does not, and
   * the allowlist refuses it unless it is listed by hand.
   */
  readonly authenticated: boolean;
  readonly answer: DesktopCloudAnswer;
  /** Whether a 2xx with no body is one of the declared answers (a 204, an empty 201). */
  readonly empty: boolean;
  /** The request headers the endpoint declares, lower-cased. */
  readonly headers: ReadonlySet<string>;
}

const STREAM_SCHEMA = "~effect/http-api/HttpApiSchema/Stream";
const UPGRADE_SCHEMA = "~effect/http-api/HttpApiSchema/Upgrade";

/**
 * A success schema's `HttpApiSchema` encoding, read from the annotation
 * `asText`/`asUint8Array` set (the key `HttpApiSchema` itself resolves); a
 * schema without one is JSON.
 */
const ResponseEncoding = Schema.Struct({
  _tag: Schema.Literals(["Json", "FormUrlEncoded", "Uint8Array", "Text"]),
  contentType: Schema.String,
});
const decodeResponseEncoding = Schema.decodeUnknownOption(ResponseEncoding);
const encodingAnnotation = SchemaAST.resolveAt<unknown>("~httpApiEncoding");

type SuccessKind = DesktopCloudAnswer | "empty";

function successKind(schema: Schema.Top): SuccessKind {
  const body = HttpApiSchema.isWithHeaders(schema) ? schema.schema : schema;
  if (
    Predicate.hasProperty(body, STREAM_SCHEMA) ||
    Predicate.hasProperty(body, UPGRADE_SCHEMA) ||
    Predicate.hasProperty(schema, UPGRADE_SCHEMA)
  ) {
    return "stream";
  }
  if (HttpApiSchema.isNoContent(body.ast)) return "empty";
  const encoding = decodeResponseEncoding(encodingAnnotation(body.ast));
  if (encoding._tag === "None") return "json";
  switch (encoding.value._tag) {
    case "Uint8Array":
      return "bytes";
    case "Text":
      // The contract's SSE turn stream is text in an event-stream envelope.
      return encoding.value.contentType.startsWith("text/event-stream") ? "stream" : "text";
    case "FormUrlEncoded":
      return "text";
    case "Json":
      return "json";
  }
}

/** The endpoint's answer, the widest kind any of its successes is. */
function answerOf(successes: ReadonlyMap<number, ReadonlyArray<Schema.Top>>) {
  const kinds = new Set<SuccessKind>();
  for (const schemas of successes.values())
    for (const schema of schemas) kinds.add(successKind(schema));
  const answer: DesktopCloudAnswer = kinds.has("stream")
    ? "stream"
    : kinds.has("bytes")
      ? "bytes"
      : kinds.has("text")
        ? "text"
        : "json";
  return { answer, empty: kinds.has("empty") };
}

/** The names a `headers` schema declares (a struct of header names), lower-cased. */
function headerNames(schema: Schema.Top | undefined): ReadonlySet<string> {
  if (schema === undefined) return new Set();
  const ast = SchemaAST.toType(schema.ast);
  if (!SchemaAST.isObjects(ast)) return new Set();
  return new Set(ast.propertySignatures.map((property) => String(property.name).toLowerCase()));
}

const AUTH_MIDDLEWARE: ReadonlySet<string> = new Set([OrgAuth.key, SessionAuth.key]);

const isAuthenticated = (middleware: ReadonlySet<HttpApiMiddleware.AnyService>) =>
  [...middleware].some((service) => AUTH_MIDDLEWARE.has(service.key));

/**
 * A registered domain: the `HttpApi` itself, which the renderer's client type
 * is derived from, and its endpoints walked once, which both ends build from
 * at runtime without needing the API's exact type.
 */
export interface DesktopCloudApi<Api> {
  readonly api: Api;
  readonly endpoints: ReadonlyArray<DesktopCloudEndpoint>;
}

function desktopCloudApi<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): DesktopCloudApi<HttpApi.HttpApi<Id, Groups>> {
  const endpoints: Array<DesktopCloudEndpoint> = [];
  HttpApi.reflect(api, {
    onGroup() {},
    onEndpoint({ group, endpoint, mergedAnnotations, middleware, successes }) {
      endpoints.push({
        group: group.identifier,
        endpoint,
        annotations: mergedAnnotations,
        authenticated: isAuthenticated(middleware),
        ...answerOf(successes),
        headers: headerNames(endpoint.headers),
      });
    },
  });
  return { api, endpoints };
}

export const DESKTOP_CLOUD_APIS = {
  probes: desktopCloudApi(ProbesApi),
  slos: desktopCloudApi(SlosApi),
  accessReview: desktopCloudApi(AccessReviewApi),
  calendar: desktopCloudApi(CalendarApi),
  dns: desktopCloudApi(DnsApi),
  environmentDiff: desktopCloudApi(EnvironmentDiffApi),
  expiring: desktopCloudApi(ExpiringApi),
  extendedSupport: desktopCloudApi(ExtendedSupportApi),
  idleFindings: desktopCloudApi(IdleFindingsApi),
  leakedSecrets: desktopCloudApi(LeakedSecretsApi),
  moment: desktopCloudApi(MomentApi),
  orphans: desktopCloudApi(OrphansApi),
  ownership: desktopCloudApi(OwnershipApi),
  posture: desktopCloudApi(PostureApi),
  priceCatalog: desktopCloudApi(PriceCatalogApi),
  quotas: desktopCloudApi(QuotasApi),
  resources: desktopCloudApi(ResourcesApi),
  rightsizing: desktopCloudApi(RightsizingApi),
  search: desktopCloudApi(SearchApi),
  seats: desktopCloudApi(SeatsApi),
  sshFanout: desktopCloudApi(SshFanoutApi),
  sshTunnels: desktopCloudApi(SshTunnelsApi),
  starred: desktopCloudApi(StarredApi),
  vulnerabilities: desktopCloudApi(VulnerabilitiesApi),
  wallboard: desktopCloudApi(WallboardApi),
  connections: desktopCloudApi(ConnectionsApi),
  incidents: desktopCloudApi(IncidentsApi),
  pagingProviders: desktopCloudApi(PagingProvidersApi),
  accounts: desktopCloudApi(AccountsApi),
  agents: desktopCloudApi(AgentsApi),
  chat: desktopCloudApi(ChatApi),
  compliance: desktopCloudApi(ComplianceApi),
  deployments: desktopCloudApi(DeploymentsApi),
  environments: desktopCloudApi(EnvironmentsApi),
  k8sEfficiencyReports: desktopCloudApi(KubernetesEfficiencyReportsApi),
  resourceReports: desktopCloudApi(ResourceReportsApi),
  billingProfiles: desktopCloudApi(BillingProfilesApi),
  billingRules: desktopCloudApi(BillingRulesApi),
  blastRadius: desktopCloudApi(BlastRadiusApi),
  costCanvases: desktopCloudApi(CostCanvasesApi),
  costCentres: desktopCloudApi(CostCentresApi),
  dashboards: desktopCloudApi(DashboardsApi),
  dependencyGraph: desktopCloudApi(DependencyGraphApi),
  invoices: desktopCloudApi(InvoicesApi),
  onCall: desktopCloudApi(OnCallApi),
  scorecards: desktopCloudApi(ScorecardsApi),
  services: desktopCloudApi(ServicesApi),
  sshKeys: desktopCloudApi(SshKeysApi),
  tagKeys: desktopCloudApi(TagKeysApi),
  virtualTags: desktopCloudApi(VirtualTagsApi),
  workflowApprovals: desktopCloudApi(WorkflowApprovalsApi),
  workflowSecrets: desktopCloudApi(WorkflowSecretsApi),
  workflows: desktopCloudApi(WorkflowsApi),
  github: desktopCloudApi(GithubApi),
  backups: desktopCloudApi(BackupsApi),
  changes: desktopCloudApi(ResourceChangesApi),
  costAnnotations: desktopCloudApi(CostAnnotationsApi),
  customGraphs: desktopCloudApi(CustomGraphsApi),
  dora: desktopCloudApi(DoraApi),
  ci: desktopCloudApi(CiApi),
  orgFeatures: desktopCloudApi(OrgFeaturesApi),
  products: desktopCloudApi(ProductsApi),
  iac: desktopCloudApi(IacApi),
  leases: desktopCloudApi(LeasesApi),
  logWorkspaces: desktopCloudApi(LogWorkspacesApi),
  metricAlerts: desktopCloudApi(MetricAlertsApi),
  networkFlows: desktopCloudApi(NetworkFlowsApi),
  queryMonitors: desktopCloudApi(QueryMonitorsApi),
  runbooks: desktopCloudApi(RunbooksApi),
  savingsFindings: desktopCloudApi(SavingsFindingsApi),
  schedules: desktopCloudApi(SchedulesApi),
  statusIncidents: desktopCloudApi(StatusIncidentsApi),
  statusPages: desktopCloudApi(StatusPagesApi),
  alertEmail: desktopCloudApi(AlertEmailApi),
  budgets: desktopCloudApi(BudgetsApi),
  businessMetrics: desktopCloudApi(BusinessMetricsApi),
  carbon: desktopCloudApi(CarbonApi),
  commitments: desktopCloudApi(CommitmentsApi),
  costAlerts: desktopCloudApi(CostAlertsApi),
  costAnomalyFeedback: desktopCloudApi(CostAnomalyFeedbackApi),
  costExportJobs: desktopCloudApi(CostExportJobsApi),
  costReportAnomalyAlerts: desktopCloudApi(CostReportAnomalyAlertsApi),
  costReportFolders: desktopCloudApi(CostReportFoldersApi),
  costReportNotifications: desktopCloudApi(CostReportNotificationsApi),
  costReports: desktopCloudApi(CostReportsApi),
  costScenarios: desktopCloudApi(CostScenariosApi),
  costs: desktopCloudApi(CostsApi),
  credits: desktopCloudApi(CreditsApi),
  dashboardNotifications: desktopCloudApi(DashboardNotificationsApi),
  savedCostFilters: desktopCloudApi(SavedCostFiltersApi),
  savings: desktopCloudApi(SavingsApi),
  tagPolicy: desktopCloudApi(TagPolicyApi),
} as const;

export type DesktopCloudApis = typeof DESKTOP_CLOUD_APIS;
export type DesktopCloudApiName = keyof DesktopCloudApis;
