/** Bearer fetch wrappers for `/api/org/:orgId/environments`. */
import type { CloudFetch } from "../fetch";
import type {
  CaptureDraft,
  EnvironmentCostEstimate,
  EnvironmentInstance,
  EnvironmentInstanceListResponse,
  EnvironmentInstantiateInput,
  EnvironmentSettings,
  EnvironmentTemplate,
  EnvironmentTemplateInput,
  EnvironmentTemplateListResponse,
} from "./types";
import { normalizeEnvironmentSettings } from "./template";

// ---------------------------------------------------------------------------
// Bearer helpers
// ---------------------------------------------------------------------------

/** Read the org's templates (`resources:read`). */
export async function fetchEnvironmentTemplates(
  api: CloudFetch,
  orgId: string,
): Promise<EnvironmentTemplateListResponse> {
  const res = await api.org<EnvironmentTemplateListResponse>(orgId, "/environments/templates");
  return res ?? { templates: [] };
}

/** Read the org's instances (`resources:read`). */
export async function fetchEnvironmentInstances(
  api: CloudFetch,
  orgId: string,
): Promise<EnvironmentInstanceListResponse> {
  const res = await api.org<EnvironmentInstanceListResponse>(orgId, "/environments/instances");
  return res ?? { instances: [] };
}

/** Read the org's TTL rails (`resources:read`). */
export async function fetchEnvironmentSettings(
  api: CloudFetch,
  orgId: string,
): Promise<EnvironmentSettings> {
  const res = await api.org<EnvironmentSettings>(orgId, "/environments/settings");
  return normalizeEnvironmentSettings(res);
}

/** Update the org's TTL rails (`org:settings:write`). */
export async function updateEnvironmentSettings(
  api: CloudFetch,
  orgId: string,
  body: EnvironmentSettings,
): Promise<EnvironmentSettings | null> {
  return api.org<EnvironmentSettings>(orgId, "/environments/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Preview a capture without persisting anything (`resources:read`). */
export async function previewEnvironmentCapture(
  api: CloudFetch,
  orgId: string,
  body: { resourceIds?: string[]; accountId?: string; tagKey?: string; tagValue?: string },
): Promise<CaptureDraft | null> {
  return api.org<CaptureDraft>(orgId, "/environments/capture", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Persist a template (`resources:write`). */
export async function createEnvironmentTemplate(
  api: CloudFetch,
  orgId: string,
  body: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate | null> {
  return api.org<EnvironmentTemplate>(orgId, "/environments/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Replace a template (`resources:write`). */
export async function updateEnvironmentTemplate(
  api: CloudFetch,
  orgId: string,
  templateId: string,
  body: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate | null> {
  return api.org<EnvironmentTemplate>(
    orgId,
    `/environments/templates/${encodeURIComponent(templateId)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

/** Remove a template (`resources:write`). Live instances keep running. */
export async function deleteEnvironmentTemplate(
  api: CloudFetch,
  orgId: string,
  templateId: string,
): Promise<void> {
  await api.org(orgId, `/environments/templates/${encodeURIComponent(templateId)}`, {
    method: "DELETE",
  });
}

/** Price an instantiation before it runs (`resources:read`). */
export async function estimateEnvironmentCost(
  api: CloudFetch,
  orgId: string,
  templateId: string,
  body: { parameters?: Record<string, string> },
): Promise<EnvironmentCostEstimate | null> {
  return api.org<EnvironmentCostEstimate>(
    orgId,
    `/environments/templates/${encodeURIComponent(templateId)}/estimate`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Stamp out a copy (`resources:write` **and** `resources:delete` — every
 * instance carries a standing auto-delete, which is the permission the leases
 * API gates that on).
 */
export async function instantiateEnvironment(
  api: CloudFetch,
  orgId: string,
  templateId: string,
  body: EnvironmentInstantiateInput,
): Promise<EnvironmentInstance | null> {
  return api.org<EnvironmentInstance>(
    orgId,
    `/environments/templates/${encodeURIComponent(templateId)}/instantiate`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Tear an instance down now (`resources:delete`). */
export async function tearDownEnvironmentInstance(
  api: CloudFetch,
  orgId: string,
  instanceId: string,
): Promise<EnvironmentInstance | null> {
  return api.org<EnvironmentInstance>(
    orgId,
    `/environments/instances/${encodeURIComponent(instanceId)}/teardown`,
    { method: "POST" },
  );
}

/** Forget a torn-down instance's row (`resources:write`). */
export async function deleteEnvironmentInstance(
  api: CloudFetch,
  orgId: string,
  instanceId: string,
): Promise<void> {
  await api.org(orgId, `/environments/instances/${encodeURIComponent(instanceId)}`, {
    method: "DELETE",
  });
}
