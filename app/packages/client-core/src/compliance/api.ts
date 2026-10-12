/**
 * Bearer readers for the compliance routes, shared by mobile (read-only
 * status) and any other client holding a `CloudFetch`. Web and desktop go
 * through the shared UI's host-injected client instead.
 */
import type { CloudFetch } from "../fetch";
import type {
  CompliancePeriod,
  ComplianceFrameworkSummary,
  ComplianceStatusResponse,
} from "./status";

/** `GET /compliance/frameworks` (permission `audit:read`). */
export async function fetchComplianceFrameworks(
  api: CloudFetch,
  orgId: string,
): Promise<ComplianceFrameworkSummary[]> {
  const res = await api.org<{ frameworks: ComplianceFrameworkSummary[] }>(
    orgId,
    "/compliance/frameworks",
  );
  return res?.frameworks ?? [];
}

/** Query string for a status read or a pack download. */
export function complianceQuery(frameworkId: string, period?: Partial<CompliancePeriod>): string {
  const query = new URLSearchParams({ framework: frameworkId });
  if (period?.from) query.set("from", period.from);
  if (period?.to) query.set("to", period.to);
  return query.toString();
}

/** `GET /compliance?framework=…&from=…&to=…` (permission `audit:read`). */
export async function fetchComplianceStatus(
  api: CloudFetch,
  orgId: string,
  frameworkId: string,
  period?: Partial<CompliancePeriod>,
): Promise<ComplianceStatusResponse | null> {
  return api.org<ComplianceStatusResponse>(
    orgId,
    `/compliance?${complianceQuery(frameworkId, period)}`,
  );
}
