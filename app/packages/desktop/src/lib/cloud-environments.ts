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
import type { EnvironmentCaptureSelector } from "@infrawrench/ui/environments";
import { invoke } from "./invoke";

export async function listCloudEnvironmentTemplates(
  orgId: string,
): Promise<EnvironmentTemplateListResponse> {
  return invoke("cloud_environments_templates", { orgId });
}

export async function listCloudEnvironmentInstances(
  orgId: string,
): Promise<EnvironmentInstanceListResponse> {
  return invoke("cloud_environments_instances", { orgId });
}

export async function fetchCloudEnvironmentSettings(orgId: string): Promise<EnvironmentSettings> {
  return invoke("cloud_environments_settings", { orgId });
}

export async function updateCloudEnvironmentSettings(
  orgId: string,
  settings: EnvironmentSettings,
): Promise<EnvironmentSettings> {
  return invoke("cloud_environments_settings_update", { orgId, settings });
}

export async function captureCloudEnvironmentDraft(
  orgId: string,
  selector: EnvironmentCaptureSelector,
): Promise<CaptureDraft> {
  return invoke("cloud_environments_capture", { orgId, selector });
}

export async function createCloudEnvironmentTemplate(
  orgId: string,
  input: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate> {
  return invoke("cloud_environments_template_create", { orgId, input });
}

export async function deleteCloudEnvironmentTemplate(
  orgId: string,
  templateId: string,
): Promise<void> {
  await invoke("cloud_environments_template_delete", { orgId, templateId });
}

export async function estimateCloudEnvironment(
  orgId: string,
  templateId: string,
  body: { parameters?: Record<string, string> },
): Promise<EnvironmentCostEstimate> {
  return invoke("cloud_environments_estimate", { orgId, templateId, body });
}

export async function instantiateCloudEnvironment(
  orgId: string,
  templateId: string,
  body: EnvironmentInstantiateInput,
): Promise<EnvironmentInstance> {
  return invoke("cloud_environments_instantiate", { orgId, templateId, body });
}

export async function tearDownCloudEnvironment(
  orgId: string,
  instanceId: string,
): Promise<EnvironmentInstance> {
  return invoke("cloud_environments_teardown", { orgId, instanceId });
}

export async function forgetCloudEnvironment(orgId: string, instanceId: string): Promise<void> {
  await invoke("cloud_environments_forget", { orgId, instanceId });
}
