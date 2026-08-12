import type {
  EnvironmentAccount,
  EnvironmentCaptureSelector,
  EnvironmentsClient,
} from "@infrawrench/ui/environments";
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
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * Web implementation of the shared environments client, per org.
 *
 * The write methods are always present here — the server is the permission
 * boundary and answers 403 for a caller that may not spend money. The optional
 * shape exists for desktop's local-only mode, where there is no org to spend
 * in at all.
 */
export function createWebEnvironmentsClient(orgId: string): EnvironmentsClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/environments`;
  return {
    listTemplates: async () =>
      (await apiGet<EnvironmentTemplateListResponse>(`${base}/templates`)).templates,
    listInstances: async () =>
      (await apiGet<EnvironmentInstanceListResponse>(`${base}/instances`)).instances,
    getSettings: () => apiGet<EnvironmentSettings>(`${base}/settings`),
    listAccounts: async () => {
      const rows = await apiGet<EnvironmentAccount[]>(
        `/api/org/${encodeURIComponent(orgId)}/accounts`,
      );
      return [...rows].sort((x, y) => x.displayName.localeCompare(y.displayName));
    },
    captureDraft: (selector: EnvironmentCaptureSelector) =>
      apiPost<CaptureDraft>(`${base}/capture`, selector),
    createTemplate: (input: EnvironmentTemplateInput) =>
      apiPost<EnvironmentTemplate>(`${base}/templates`, input),
    deleteTemplate: async (templateId: string) => {
      await apiDelete(`${base}/templates/${encodeURIComponent(templateId)}`);
    },
    estimate: (templateId: string, body: { parameters?: Record<string, string> }) =>
      apiPost<EnvironmentCostEstimate>(
        `${base}/templates/${encodeURIComponent(templateId)}/estimate`,
        body,
      ),
    instantiate: (templateId: string, body: EnvironmentInstantiateInput) =>
      apiPost<EnvironmentInstance>(
        `${base}/templates/${encodeURIComponent(templateId)}/instantiate`,
        body,
      ),
    teardown: (instanceId: string) =>
      apiPost<EnvironmentInstance>(
        `${base}/instances/${encodeURIComponent(instanceId)}/teardown`,
        {},
      ),
    forget: async (instanceId: string) => {
      await apiDelete(`${base}/instances/${encodeURIComponent(instanceId)}`);
    },
    updateSettings: (settings: EnvironmentSettings) =>
      apiPut<EnvironmentSettings>(`${base}/settings`, settings),
  };
}
