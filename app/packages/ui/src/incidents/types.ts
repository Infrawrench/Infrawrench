// The wire types come from `@infrawrench/client-core` (the shared pure half);
// this module only adds the client seam a host must provide.
import type {
  Incident,
  IncidentDeclare,
  IncidentDetailResponse,
  IncidentNote,
  IncidentPatch,
  IncidentStatus,
  IncidentTimelineResponse,
  StatusPage,
} from "@infrawrench/client-core";

/**
 * What a host must provide for the incidents panel.
 *
 * The write methods are optional — their absence renders the panel read-only,
 * the capability gating `ProbesClient` and `MetricAlertsClient` established.
 * `listStatusPages` is optional separately: an org with no status pages simply
 * loses that row of the declare form rather than seeing an empty picker, and a
 * host that cannot reach the status-page API (or a surface that deliberately
 * does not offer publishing) omits it.
 */
export interface IncidentsClient {
  listIncidents(status?: IncidentStatus | "all"): Promise<Incident[]>;
  getIncident(incidentId: string): Promise<IncidentDetailResponse>;
  getTimeline(incidentId: string): Promise<IncidentTimelineResponse>;
  getPostmortem(incidentId: string): Promise<{ markdown: string; filename: string }>;

  declareIncident?(input: IncidentDeclare): Promise<Incident>;
  updateIncident?(incidentId: string, patch: IncidentPatch): Promise<Incident>;
  addNote?(incidentId: string, body: string, occurredAt?: string): Promise<IncidentNote>;
  deleteNote?(incidentId: string, noteId: string): Promise<void>;
  retryArtifacts?(incidentId: string): Promise<Incident>;
  deleteIncident?(incidentId: string): Promise<void>;

  /** Status pages the declaration may publish an update on. */
  listStatusPages?(): Promise<StatusPage[]>;
}

/**
 * Everything the "Declare incident" button on another surface knows about what
 * it is declaring an incident *for*.
 *
 * This is how a probe row or a firing metric alert opens the declare form with
 * the title and the affected resource already filled in — the alternative,
 * making somebody retype it while the graph is still red, is the reason
 * incidents get declared in Slack instead of in a tool.
 */
export interface IncidentSeed {
  title?: string;
  summary?: string;
  severity?: Incident["severity"];
  resourceIds?: string[];
  /** ISO — when the thing that prompted this actually started. */
  startedAt?: string;
}
