/**
 * Every API domain served by HttpApi. One line per domain; the server, the
 * spec builder and the route-shadowing test all read this list.
 *
 * A request no domain matches falls through to the legacy Hono app, so a
 * domain moves here by deleting its Hono routes in the same change.
 */
import type { Domain } from "./domain";
import { budgetsDomain } from "./domains/budgets/index";
import { onCallDomain } from "./domains/on-call/index";
import { queryMonitorsDomain } from "./domains/query-monitors/index";
import { runbooksDomain } from "./domains/runbooks/index";
import { pagingProvidersDomain } from "./domains/paging-providers/index";
import { incidentsDomain } from "./domains/incidents/index";
import { probesDomain } from "./domains/probes/index";
import { slosDomain } from "./domains/slos/index";
import { servicesDomain } from "./domains/services/index";
import { scorecardsDomain } from "./domains/scorecards/index";
import { doraDomain } from "./domains/dora/index";
import { ownershipDomain } from "./domains/ownership/index";
import { associationsDomain } from "./domains/associations/index";
import { blastRadiusDomain } from "./domains/blast-radius/index";
import { calendarDomain } from "./domains/calendar/index";
import { changeFreezesDomain } from "./domains/change-freezes/index";
import { dependencyGraphDomain } from "./domains/dependency-graph/index";
import { dnsDomain } from "./domains/dns/index";
import { environmentDiffDomain } from "./domains/environment-diff/index";
import { environmentsDomain } from "./domains/environments/index";
import { leasesDomain } from "./domains/leases/index";
import { schedulesDomain } from "./domains/schedules/index";
import { teamDomain } from "./domains/team/index";
import { apiKeysDomain } from "./domains/api-keys/index";
import { auditDomain } from "./domains/audit/index";
import { sshKeysDomain } from "./domains/ssh-keys/index";
import { bastionsDomain } from "./domains/bastions/index";
import { accessReviewDomain } from "./domains/access-review/index";
import { credentialHygieneDomain } from "./domains/credential-hygiene/index";
import { jitAccessDomain } from "./domains/jit-access/index";
import { accessRequestsDomain } from "./domains/access-requests/index";
import { postureDomain } from "./domains/posture/index";
import { wallboardDomain } from "./domains/wallboard/index";
import { expiringDomain } from "./domains/expiring/index";
import { extendedSupportDomain } from "./domains/extended-support/index";
import { quotasDomain } from "./domains/quotas/index";
import { vulnerabilitiesDomain } from "./domains/vulnerabilities/index";
import { leakedSecretsDomain } from "./domains/leaked-secrets/index";

export const DOMAINS: readonly Domain[] = [
  budgetsDomain,
  onCallDomain,
  queryMonitorsDomain,
  runbooksDomain,
  pagingProvidersDomain,
  incidentsDomain,
  probesDomain,
  slosDomain,
  servicesDomain,
  scorecardsDomain,
  doraDomain,
  ownershipDomain,
  associationsDomain,
  blastRadiusDomain,
  calendarDomain,
  changeFreezesDomain,
  dependencyGraphDomain,
  dnsDomain,
  environmentDiffDomain,
  environmentsDomain,
  leasesDomain,
  schedulesDomain,
  teamDomain,
  apiKeysDomain,
  auditDomain,
  sshKeysDomain,
  bastionsDomain,
  accessReviewDomain,
  credentialHygieneDomain,
  jitAccessDomain,
  accessRequestsDomain,
  postureDomain,
  wallboardDomain,
  expiringDomain,
  extendedSupportDomain,
  quotasDomain,
  vulnerabilitiesDomain,
  leakedSecretsDomain,
];
