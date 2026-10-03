import type {
  DetailViewSchema,
  ResourceInstance,
  SchemaNode,
  SectionNode,
} from "@infrawrench/plugin-base";

/**
 * Cartesia Managed Agents and the phone numbers routed to them. Wire shapes,
 * mapping and rendering live here; the client owns transport and dispatch.
 *
 * https://docs.cartesia.ai/api-reference/agents/agents/list
 * https://docs.cartesia.ai/api-reference/agents/deployments/list-deployments
 * https://docs.cartesia.ai/api-reference/agents/phone-numbers/list
 */

export interface CartesiaAgent {
  id: string;
  name?: string;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
  tts_voice?: string | null;
  tts_language?: string | null;
  noise_suppression_level?: number | null;
  webhook_id?: string | null;
  deleted_at?: string | null;
  git_repository?: { provider?: string; account?: string; name?: string } | null;
  git_deploy_branch?: string | null;
  self_hosted_deployment_url?: string | null;
  phone_numbers?: Array<{ id?: string; number?: string }> | null;
  deployment_count?: number | null;
}

/**
 * `GET /agents` answers `{ summaries: [...] }` in the published spec; the
 * `data` envelope the rest of the API uses is accepted too, so a future
 * alignment does not empty the list.
 */
export interface CartesiaAgentsResponse {
  summaries?: CartesiaAgent[];
  data?: CartesiaAgent[];
}

export interface CartesiaDeployment {
  id: string;
  status?: string;
  is_live?: boolean;
  is_pinned?: boolean;
  git_commit_hash?: string | null;
  region?: string | null;
  created_at?: string;
  build_error?: string | null;
  deployment_error?: string | null;
}

export interface CartesiaPhoneNumber {
  id: string;
  label?: string | null;
  number?: string;
  agent?: { id?: string; name?: string } | null;
  provider?: { type?: string; label?: string | null; region?: string | null } | null;
  created_at?: string;
  updated_at?: string;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

export function mapAgent(accountId: string, agent: CartesiaAgent): ResourceInstance {
  const now = new Date().toISOString();
  const createdAt = agent.created_at ?? now;
  const repo = agent.git_repository;
  const phoneNumbers = (agent.phone_numbers ?? [])
    .map((phone) => str(phone.number))
    .filter(Boolean);
  return {
    id: `${accountId}:agent:${agent.id}`,
    pluginId: "cartesia",
    resourceTypeId: "agent",
    accountId,
    displayName: str(agent.name) || agent.id,
    externalId: agent.id,
    fields: {
      name: str(agent.name),
      agentId: agent.id,
      description: str(agent.description),
      ttsVoice: str(agent.tts_voice),
      ttsLanguage: str(agent.tts_language),
      ...(agent.noise_suppression_level != null
        ? { noiseSuppressionLevel: agent.noise_suppression_level }
        : {}),
      webhookId: str(agent.webhook_id),
      phoneNumbers: phoneNumbers.join(", "),
      deploymentCount: agent.deployment_count ?? 0,
      gitRepository: repo?.name
        ? [repo.provider, repo.account, repo.name].filter(Boolean).join("/")
        : "",
      gitDeployBranch: str(agent.git_deploy_branch),
      selfHostedUrl: str(agent.self_hosted_deployment_url),
      createdAt,
      updatedAt: str(agent.updated_at),
    },
    resolvedOutputs: { agentId: agent.id },
    secretStates: [],
    createdAt,
    updatedAt: agent.updated_at ?? now,
  };
}

export function mapPhoneNumber(accountId: string, phone: CartesiaPhoneNumber): ResourceInstance {
  const now = new Date().toISOString();
  const createdAt = phone.created_at ?? now;
  const number = str(phone.number) || phone.id;
  const label = str(phone.label);
  return {
    id: `${accountId}:phone-number:${phone.id}`,
    pluginId: "cartesia",
    resourceTypeId: "phone-number",
    accountId,
    displayName: label ? `${label} (${number})` : number,
    externalId: phone.id,
    fields: {
      number,
      label,
      phoneNumberId: phone.id,
      agentId: str(phone.agent?.id),
      agentName: str(phone.agent?.name),
      providerType: str(phone.provider?.type),
      providerLabel: str(phone.provider?.label),
      region: str(phone.provider?.region),
      createdAt,
    },
    resolvedOutputs: { phoneNumber: number, phoneNumberId: phone.id },
    secretStates: [],
    createdAt,
    updatedAt: phone.updated_at ?? now,
  };
}

function parseDeployments(raw: string | undefined): CartesiaDeployment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartesiaDeployment[]) : [];
  } catch {
    return [];
  }
}

function kv(key: string, value: unknown) {
  return { key, value: str(value) || "-" };
}

export function renderAgentDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const deployments = parseDeployments(resource.resolvedOutputs?.["__deployments__"]);
  const live = deployments.find((deployment) => deployment.is_live);

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Agent",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Agent ID", value: str(f["agentId"]) || "-", copyable: true },
            kv("Description", f["description"]),
            kv("Voice", f["ttsVoice"]),
            kv("Language", f["ttsLanguage"]),
            kv("Noise Suppression", f["noiseSuppressionLevel"]),
            kv("Phone Numbers", f["phoneNumbers"]),
            kv("Webhook", f["webhookId"]),
            kv("Created", f["createdAt"]),
            kv("Updated", f["updatedAt"]),
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Code",
      children: [
        {
          kind: "key-value-list",
          items: [
            kv("Git Repository", f["gitRepository"]),
            kv("Deploy Branch", f["gitDeployBranch"]),
            kv("Self-Hosted URL", f["selfHostedUrl"]),
            kv("Deployments", f["deploymentCount"]),
          ],
        },
      ],
    },
  ];

  if (deployments.length) {
    const table: SchemaNode = {
      kind: "table",
      columns: [
        { key: "created", label: "Created", mono: true },
        { key: "status", label: "Status", width: "narrow" },
        { key: "live", label: "Live", width: "narrow" },
        { key: "commit", label: "Commit", mono: true, width: "narrow" },
        { key: "region", label: "Region", width: "narrow" },
        { key: "error", label: "Error", width: "wide" },
      ],
      rows: deployments.map((deployment) => ({
        cells: {
          created: str(deployment.created_at) || "-",
          status: str(deployment.status) || "-",
          live: deployment.is_live ? "Yes" : deployment.is_pinned ? "Pinned" : "No",
          commit: str(deployment.git_commit_hash).slice(0, 8) || "-",
          region: str(deployment.region) || "-",
          error: str(deployment.build_error || deployment.deployment_error) || "-",
        },
      })),
    };
    sections.push({ kind: "section", title: "Deployments", children: [table] });
  }

  return {
    title: str(f["name"]) || resource.displayName,
    subtitle: `Cartesia Agent · ${str(f["ttsLanguage"]) || "unknown language"}`,
    status: live
      ? { kind: "status-dot", status: "healthy", label: "Live" }
      : { kind: "status-dot", status: "info", label: "Not deployed" },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderPhoneNumberDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const assigned = Boolean(f["agentId"]);
  return {
    title: resource.displayName,
    subtitle: `Cartesia Phone Number · ${str(f["providerType"]) || "unknown provider"}`,
    status: {
      kind: "status-dot",
      status: assigned ? "healthy" : "info",
      label: assigned ? "Assigned" : "Unassigned",
    },
    sections: [
      {
        kind: "section",
        title: "Phone Number",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Number", value: str(f["number"]) || "-", copyable: true },
              kv("Label", f["label"]),
              kv("Agent", f["agentName"] || f["agentId"] || "Unassigned"),
              kv("Provider", f["providerType"]),
              kv("Provider Account", f["providerLabel"]),
              kv("Region", f["region"]),
              kv("Created", f["createdAt"]),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
