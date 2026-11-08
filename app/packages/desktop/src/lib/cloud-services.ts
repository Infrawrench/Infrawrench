/**
 * Services and scorecards: cloud-mode only. Typed calls to the contract's
 * `services`, `scorecards`, `onCall`, `tagKeys` and `virtualTags` domains
 * over the cloud transport (`./cloud-client.ts`), matching `cloud-slos.ts`.
 */
import type {
  DiscoveredTagKeysResponse,
  OnCallSchedule,
  OrgScorecardHistoryResponse,
  OrgScorecardResponse,
  Scorecard,
  ScorecardInput,
  ScorecardListResponse,
  ScorecardOverviewResponse,
  Service,
  ServiceDetailResponse,
  ServiceInput,
  ServiceListResponse,
  ServiceScorecardsResponse,
  ServicesForResourcesResponse,
  ServiceSummaryResponse,
  VirtualTag,
  VirtualTagRule,
} from "@infrawrench/client-core";
import type { PostureCategory } from "@infrawrench/plugin-base";
import type { ServiceResourceOption } from "@infrawrench/ui/services";
import { Schema } from "effect";
import { searchCloudResourceIndex } from "./cloud-costs";
import { cloudClient } from "./cloud-client";
import { definedFields } from "./cloud-payload";
import { runRpc } from "./rpc/client";

const services = () => cloudClient("services").services;
const scorecards = () => cloudClient("scorecards").scorecards;

export function listCloudServices(orgId: string): Promise<ServiceListResponse> {
  return runRpc(services().list({ params: { orgId } }));
}

export function getCloudService(orgId: string, serviceId: string): Promise<ServiceDetailResponse> {
  return runRpc(services().get({ params: { orgId, serviceId } }));
}

const POSTURE_CATEGORIES = [
  "public-exposure",
  "encryption",
  "credential-age",
  "data-protection",
  "other",
] as const satisfies ReadonlyArray<PostureCategory>;
const isPostureCategory = Schema.is(Schema.Literals(POSTURE_CATEGORIES));

/**
 * The summary, its posture findings' `category` read as client-core's
 * bucket. The contract types that field as any string here (the posture
 * domain itself lists the buckets), so one this build does not know reads
 * as `other`, the bucket the panel already has a label for.
 */
export async function getCloudServiceSummary(
  orgId: string,
  serviceId: string,
): Promise<ServiceSummaryResponse> {
  const summary = await runRpc(services().summary({ params: { orgId, serviceId } }));
  const { posture } = summary.findings;
  return {
    ...summary,
    findings: {
      ...summary.findings,
      posture: {
        ...posture,
        items: posture.items.map((finding) => ({
          ...finding,
          category: isPostureCategory(finding.category) ? finding.category : "other",
        })),
      },
    },
  };
}

export function getCloudServiceScorecards(
  orgId: string,
  serviceId: string,
): Promise<ServiceScorecardsResponse> {
  return runRpc(services().scorecards({ params: { orgId, serviceId } }));
}

export function createCloudService(orgId: string, input: ServiceInput): Promise<Service> {
  return runRpc(services().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudService(
  orgId: string,
  serviceId: string,
  patch: Partial<ServiceInput>,
): Promise<Service> {
  return runRpc(services().update({ params: { orgId, serviceId }, payload: definedFields(patch) }));
}

export async function deleteCloudService(orgId: string, serviceId: string): Promise<void> {
  await runRpc(services().delete({ params: { orgId, serviceId } }));
}

export function addCloudServiceMembers(
  orgId: string,
  serviceId: string,
  resourceIds: string[],
): Promise<ServiceDetailResponse> {
  return runRpc(services().addMembers({ params: { orgId, serviceId }, payload: { resourceIds } }));
}

export function removeCloudServiceMember(
  orgId: string,
  serviceId: string,
  resourceId: string,
): Promise<ServiceDetailResponse> {
  return runRpc(services().removeMember({ params: { orgId, serviceId, resourceId }, query: {} }));
}

export function restoreCloudServiceMember(
  orgId: string,
  serviceId: string,
  resourceId: string,
): Promise<ServiceDetailResponse> {
  return runRpc(
    services().removeMember({
      params: { orgId, serviceId, resourceId },
      query: { restore: "1" },
    }),
  );
}

/**
 * `ids` is one comma-separated value. The query encoder escapes the commas
 * as well as the ids (the old handler left the separators raw); the server
 * decodes the value before it splits, so both read the same list.
 */
export function getCloudServicesForResources(
  orgId: string,
  resourceIds: string[],
): Promise<ServicesForResourcesResponse> {
  return runRpc(
    services().forResources({ params: { orgId }, query: { ids: resourceIds.join(",") } }),
  );
}

export async function listCloudOnCallSchedules(orgId: string): Promise<OnCallSchedule[]> {
  const res = await runRpc(cloudClient("onCall").onCall.listSchedules({ params: { orgId } }));
  return res.schedules;
}

export function listCloudTagKeys(orgId: string): Promise<DiscoveredTagKeysResponse> {
  return runRpc(cloudClient("tagKeys").tagKeys.list({ params: { orgId } }));
}

/**
 * The org's virtual tags, each stored rule with every field present, as
 * client-core types it. The contract's `VirtualTag` answer reuses the rule's
 * request schema, whose encoded side leaves every field but `kind` optional
 * (the server fills an absent one on the way in); a stored rule carries them
 * all, and one that did not would read as the default the server fills.
 */
export async function listCloudVirtualTags(orgId: string): Promise<VirtualTag[]> {
  const tags = await runRpc(cloudClient("virtualTags").virtualTags.list({ params: { orgId } }));
  return tags.map((tag) => ({
    ...tag,
    rules: tag.rules.map((rule): VirtualTagRule => ({
      query: rule.query ?? "",
      description: rule.description ?? null,
      startsOn: rule.startsOn ?? null,
      endsOn: rule.endsOn ?? null,
      kind: rule.kind,
      value: rule.value ?? null,
      sources: (rule.sources ?? []).map((source) => ({
        tagKey: source.tagKey,
        valuePrefix: source.valuePrefix ?? null,
        query: source.query ?? null,
      })),
      valueTransform: rule.valueTransform ?? "none",
      allocations: (rule.allocations ?? []).map((allocation) => ({
        value: allocation.value,
        percent: allocation.percent ?? null,
        metricId: allocation.metricId ?? null,
      })),
    })),
  }));
}

export function listCloudScorecards(orgId: string): Promise<ScorecardListResponse> {
  return runRpc(scorecards().list({ params: { orgId } }));
}

export function getCloudScorecardOverview(orgId: string): Promise<ScorecardOverviewResponse> {
  return runRpc(scorecards().overview({ params: { orgId } }));
}

/** The org grade above the matrix: seven pillars, the overall and 90 days of history. */
export function getCloudOrgScorecard(orgId: string): Promise<OrgScorecardResponse> {
  return runRpc(scorecards().org({ params: { orgId } }));
}

/** The org grade's stored readings alone, oldest first. */
export function getCloudOrgScorecardHistory(
  orgId: string,
  days?: number,
): Promise<OrgScorecardHistoryResponse> {
  return runRpc(
    scorecards().orgHistory({
      params: { orgId },
      query: typeof days === "number" ? { days: String(days) } : {},
    }),
  );
}

export function createCloudScorecard(orgId: string, input: ScorecardInput): Promise<Scorecard> {
  return runRpc(scorecards().create({ params: { orgId }, payload: definedFields(input) }));
}

export function updateCloudScorecard(
  orgId: string,
  scorecardId: string,
  patch: Partial<ScorecardInput>,
): Promise<Scorecard> {
  return runRpc(
    scorecards().update({ params: { orgId, scorecardId }, payload: definedFields(patch) }),
  );
}

export async function deleteCloudScorecard(orgId: string, scorecardId: string): Promise<void> {
  await runRpc(scorecards().delete({ params: { orgId, scorecardId } }));
}

export function evaluateCloudScorecard(
  orgId: string,
  scorecardId: string,
): Promise<ScorecardOverviewResponse> {
  return runRpc(scorecards().evaluate({ params: { orgId, scorecardId } }));
}

/**
 * The spotlight resource index, through the call the savings log already
 * makes (`GET /search`, workflows left out: only resources can be members).
 */
export function searchCloudServiceResources(
  orgId: string,
  query: string,
): Promise<ServiceResourceOption[]> {
  return runRpc(searchCloudResourceIndex(orgId, query));
}
