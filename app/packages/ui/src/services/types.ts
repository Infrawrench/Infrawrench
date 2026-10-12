// The wire types come from `@infrawrench/client-core` (the shared pure half);
// this module only adds the client seam a host must provide.
import type {
  DiscoveredTagKeysResponse,
  OnCallSchedule,
  OrgScorecardResponse,
  OwnerCandidate,
  Runbook,
  Scorecard,
  ScorecardInput,
  ScorecardOverviewResponse,
  Service,
  ServiceDetailResponse,
  ServiceInput,
  ServiceScorecardsResponse,
  ServiceSummaryResponse,
  Slo,
  VirtualTag,
} from "@infrawrench/client-core";

/** One resource the "Add resources" search offers (the spotlight index row). */
export interface ServiceResourceOption {
  id: string;
  displayName: string;
  pluginId: string;
  pluginDisplayName?: string | undefined;
  resourceTypeId: string;
  resourceTypeLabel?: string | undefined;
  accountId: string;
  accountName?: string | undefined;
}

/** A connected account, for narrowing a membership rule. */
export interface ServiceAccountOption {
  id: string;
  pluginId: string;
  displayName: string;
}

/**
 * What a host must provide for the Services panel. The write methods are
 * optional: their absence renders the panel read-only, the `SlosClient`
 * convention. The picker reads (`listOwnerCandidates` onwards) feed the
 * editors so nobody types an id; one that fails just leaves its picker empty.
 */
export interface ServicesClient {
  listServices(): Promise<Service[]>;
  getService(serviceId: string): Promise<ServiceDetailResponse>;
  getServiceSummary(serviceId: string): Promise<ServiceSummaryResponse>;
  getServiceScorecards(serviceId: string): Promise<ServiceScorecardsResponse>;
  listScorecards(): Promise<Scorecard[]>;
  getScorecardOverview(): Promise<ScorecardOverviewResponse>;
  /** The org grade above the matrix (`GET /scorecards/org`). */
  getOrgScorecard(): Promise<OrgScorecardResponse>;

  listOwnerCandidates(): Promise<OwnerCandidate[]>;
  listOnCallSchedules(): Promise<OnCallSchedule[]>;
  listSlos(): Promise<Slo[]>;
  listRunbooks(): Promise<Runbook[]>;
  listTagKeys(): Promise<DiscoveredTagKeysResponse>;
  listVirtualTags(): Promise<VirtualTag[]>;
  listAccounts(): Promise<ServiceAccountOption[]>;
  searchResources(query: string): Promise<ServiceResourceOption[]>;

  createService?(input: ServiceInput): Promise<Service | null>;
  updateService?(serviceId: string, patch: Partial<ServiceInput>): Promise<Service | null>;
  deleteService?(serviceId: string): Promise<void>;
  addMembers?(serviceId: string, resourceIds: string[]): Promise<ServiceDetailResponse | null>;
  /** Removes a hand-added member, or excludes a rule-matched one. */
  removeMember?(serviceId: string, resourceId: string): Promise<ServiceDetailResponse | null>;
  /** Lifts an exclusion so the rule applies again. */
  restoreMember?(serviceId: string, resourceId: string): Promise<ServiceDetailResponse | null>;

  createScorecard?(input: ScorecardInput): Promise<Scorecard | null>;
  updateScorecard?(scorecardId: string, patch: Partial<ScorecardInput>): Promise<Scorecard | null>;
  deleteScorecard?(scorecardId: string): Promise<void>;
  evaluateScorecard?(scorecardId: string): Promise<ScorecardOverviewResponse | null>;
}
