/**
 * Ephemeral environments: cloud-mode only. Typed calls to the contract's
 * `environments` domain over the cloud transport (`./cloud-client.ts`); each
 * answer is handed on as the client-core type the panel uses, so a contract
 * change the desktop's types disagree with fails here at compile time.
 */
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
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const environments = () => cloudClient("environments").environments;

export async function listCloudEnvironmentTemplates(
  orgId: string,
): Promise<EnvironmentTemplateListResponse> {
  return runRpc(environments().listTemplates({ params: { orgId } }));
}

export async function listCloudEnvironmentInstances(
  orgId: string,
): Promise<EnvironmentInstanceListResponse> {
  return runRpc(environments().listInstances({ params: { orgId } }));
}

export async function fetchCloudEnvironmentSettings(orgId: string): Promise<EnvironmentSettings> {
  return runRpc(environments().getSettings({ params: { orgId } }));
}

export async function updateCloudEnvironmentSettings(
  orgId: string,
  settings: EnvironmentSettings,
): Promise<EnvironmentSettings> {
  return runRpc(environments().setSettings({ params: { orgId }, payload: settings }));
}

export async function captureCloudEnvironmentDraft(
  orgId: string,
  selector: EnvironmentCaptureSelector,
): Promise<CaptureDraft> {
  return runRpc(environments().capture({ params: { orgId }, payload: selector }));
}

export async function createCloudEnvironmentTemplate(
  orgId: string,
  input: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate> {
  return runRpc(environments().createTemplate({ params: { orgId }, payload: input }));
}

export async function deleteCloudEnvironmentTemplate(
  orgId: string,
  templateId: string,
): Promise<void> {
  await runRpc(environments().deleteTemplate({ params: { orgId, templateId } }));
}

export async function estimateCloudEnvironment(
  orgId: string,
  templateId: string,
  body: { parameters?: Record<string, string> },
): Promise<EnvironmentCostEstimate> {
  return runRpc(environments().estimate({ params: { orgId, templateId }, payload: body }));
}

export async function instantiateCloudEnvironment(
  orgId: string,
  templateId: string,
  body: EnvironmentInstantiateInput,
): Promise<EnvironmentInstance> {
  return runRpc(environments().instantiate({ params: { orgId, templateId }, payload: body }));
}

export async function tearDownCloudEnvironment(
  orgId: string,
  instanceId: string,
): Promise<EnvironmentInstance> {
  return runRpc(environments().teardown({ params: { orgId, instanceId } }));
}

export async function forgetCloudEnvironment(orgId: string, instanceId: string): Promise<void> {
  await runRpc(environments().deleteInstance({ params: { orgId, instanceId } }));
}
