import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { AUTO_STOP_OPTIONS, DEFAULT_TTL_SECONDS, NONE, autoStopField } from "./create-config.js";
import { ONLINE_STATES, SANDBOX_SIZES } from "./resource-types.js";

/** Prompt-backed commands, run through `executeNoSqlCommand`. */
export const COMMANDS = {
  authorizeSshKey: "authorize-ssh-key",
  hostPort: "host-port",
  resume: "resume",
  fork: "fork",
  saveSnapshot: "save-snapshot",
  prompt: "prompt-agent",
  setEnvVar: "set-env-var",
  deleteEnvVar: "delete-env-var",
} as const;

/** Agent harnesses `POST /sandboxes/{id}/prompt` accepts, as boat names them. */
export const PROMPT_PROVIDERS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
  { id: "kimi-code", label: "Kimi Code" },
  { id: "mistral", label: "Mistral Vibe" },
  { id: "prime-agent", label: "Prime Agent" },
] as const;

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "sandbox": {
      const state = String(f["state"] ?? "");
      if (state === "error") return "error";
      if (ONLINE_STATES.includes(state)) return f["health"] === "degraded" ? "degraded" : "healthy";
      if (["init", "provisioning", "provisioned", "cloning", "archiving"].includes(state))
        return "provisioning";
      return "unknown";
    }
    case "saved-snapshot":
      switch (String(f["status"] ?? "")) {
        case "ready":
          return "healthy";
        case "saving":
          return "provisioning";
        case "failed":
          return "error";
        default:
          return "unknown";
      }
    case "api-key":
      return f["expired"] === true ? "error" : "info";
    default:
      return "info";
  }
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirmMessage?: string; successMessage?: string; destructive?: boolean } = {},
): ActionNode {
  return { kind: "action", label, action: { type: "plugin-action", actionId, ...opts } };
}

function prompt(
  label: string,
  command: string,
  fields: CreateFieldConfig[],
  opts: { title?: string; description?: string; submitLabel?: string; danger?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: { type: "prompt-nosql-command", command, fields, ...opts },
  };
}

function sizeSelect(required: boolean): CreateFieldConfig {
  return {
    key: "size",
    label: "Size",
    kind: "select",
    required,
    options: [
      ...(required ? [] : [{ id: NONE, label: "Keep the current size" }]),
      ...SANDBOX_SIZES.map((s) => ({ id: s, label: s })),
    ],
    defaultValue: required ? "default" : NONE,
  };
}

function sandboxActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const state = String(f["state"] ?? "");
  const online = ONLINE_STATES.includes(state);
  const stopped = state === "archived" || state === "error";
  const ttl = typeof f["ttlSeconds"] === "number" ? String(f["ttlSeconds"]) : NONE;
  const knownTtl = AUTO_STOP_OPTIONS.some((o) => o.id === ttl) ? ttl : String(DEFAULT_TTL_SECONDS);
  const actions: ActionNode[] = [];
  if (online) {
    actions.push(
      prompt(
        "Authorize SSH key",
        COMMANDS.authorizeSshKey,
        [{ key: "publicKey", label: "Public Key", kind: "ssh-key-picker", required: true }],
        {
          title: "Authorize an SSH key",
          description: "boat installs the key for the user account on this sandbox.",
          submitLabel: "Authorize",
        },
      ),
      prompt(
        "Prompt agent",
        COMMANDS.prompt,
        [
          {
            key: "provider",
            label: "Agent",
            kind: "select",
            required: true,
            options: PROMPT_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
            defaultValue: "claude-code",
          },
          {
            key: "prompt",
            label: "Prompt",
            kind: "text",
            multiline: true,
            required: true,
          },
          {
            key: "model",
            label: "Model",
            kind: "text",
            required: false,
            description: "Empty uses the agent's default",
          },
          {
            key: "new",
            label: "Conversation",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "Continue the current one" },
              { id: "true", label: "Start a new one" },
            ],
            defaultValue: "false",
          },
        ],
        {
          title: "Prompt an agent in this sandbox",
          description:
            "The agent must be set up on the account (an API key or subscription) first. The run continues in the sandbox.",
          submitLabel: "Send",
        },
      ),
      pluginAction("Interrupt agents", "interrupt", {
        confirmMessage: "Interrupt every agent turn running in this sandbox?",
        successMessage: "Interrupted.",
      }),
      prompt(
        "Host a port",
        COMMANDS.hostPort,
        [
          {
            key: "port",
            label: "Port",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "access",
            label: "Access",
            kind: "select",
            required: true,
            options: [
              { id: "private", label: "Private", description: "The URL carries an access token" },
              { id: "public", label: "Public", description: "Anyone with the URL" },
            ],
            defaultValue: "private",
          },
          {
            key: "localhost",
            label: "Service Listens on localhost Only",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes, relay to localhost" },
            ],
            defaultValue: "false",
          },
        ],
        {
          title: "Serve a port over HTTPS",
          description: "The URL appears under Hosted Port URLs in the Connect section.",
          submitLabel: "Host",
        },
      ),
    );
  }
  if (online || state === "archived") {
    actions.push(
      prompt(
        "Save snapshot",
        COMMANDS.saveSnapshot,
        [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "golden-image",
            description: "Lowercase letters, digits and dashes; up to 63",
          },
        ],
        {
          title: "Save a named snapshot",
          description: "New sandboxes can start from it. Saving runs in the background.",
          submitLabel: "Save",
        },
      ),
      prompt("Fork", COMMANDS.fork, [sizeSelect(false), autoStopField()], {
        title: "Fork into a new running sandbox",
        description: "The copy starts from this sandbox's files and is billed on its own.",
        submitLabel: "Fork",
      }),
    );
  }
  if (online) {
    actions.push(
      pluginAction("Stop", "stop", {
        confirmMessage: "Stop this sandbox? Its files are snapshotted and billing stops.",
        successMessage: "Stopping.",
      }),
      pluginAction("Force stop", "force-stop", {
        confirmMessage:
          "Force stop discards anything written since the last snapshot. Stop it anyway?",
        successMessage: "Stopping.",
        destructive: true,
      }),
    );
  }
  if (stopped) {
    actions.push(
      prompt("Resume", COMMANDS.resume, [sizeSelect(false), autoStopField(knownTtl)], {
        title: "Resume this sandbox",
        submitLabel: "Resume",
      }),
    );
  }
  if (f["visibility"] === "private" && f["access"] === "owner") {
    actions.push(
      pluginAction("Share with organization", "share", {
        confirmMessage:
          "Let every member of the organization use this sandbox? boat restarts it without your personal logins if it holds any.",
        successMessage: "Shared.",
      }),
    );
  }
  if (f["visibility"] === "shared" && f["access"] === "owner") {
    actions.push(
      pluginAction("Make private", "unshare", {
        confirmMessage: "Only you will be able to use this sandbox. Continue?",
        successMessage: "Made private.",
      }),
    );
  }
  return actions;
}

function environmentActions(resource: ResourceInstance): ActionNode[] {
  const names = String(resource.fields["envVarNames"] ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const actions: ActionNode[] = [
    prompt(
      "Set env var",
      COMMANDS.setEnvVar,
      [
        { key: "key", label: "Name", kind: "text", required: true, placeholder: "API_URL" },
        { key: "value", label: "Value", kind: "password", required: true },
      ],
      {
        title: "Set an environment variable",
        description: "Saves a new version. Running sandboxes keep theirs until upgraded.",
        submitLabel: "Save",
      },
    ),
  ];
  if (names.length > 0) {
    actions.push(
      prompt(
        "Remove env var",
        COMMANDS.deleteEnvVar,
        [
          {
            key: "key",
            label: "Name",
            kind: "select",
            required: true,
            options: names.map((n) => ({ id: n, label: n })),
            defaultValue: names[0]!,
          },
        ],
        { title: "Remove an environment variable", submitLabel: "Remove", danger: true },
      ),
    );
  }
  actions.push(
    pluginAction("Upgrade sandboxes", "upgrade", {
      confirmMessage:
        "Move every sandbox on this environment to its latest version? Running sandboxes pick it up live.",
      successMessage: "Upgrade requested.",
    }),
  );
  return actions;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const actions: ActionNode[] = [];
  if (resource.resourceTypeId === "sandbox") actions.push(...sandboxActions(resource));
  if (resource.resourceTypeId === "environment") actions.push(...environmentActions(resource));
  if (resource.resourceTypeId === "webhook") {
    actions.push(
      pluginAction("Rotate signing secret", "rotate-secret", {
        confirmMessage:
          "Issue a new signing secret? Deliveries are signed with the new one from now on, so update the receiver too.",
        successMessage: "Rotated. The new secret is the Signing Secret output.",
      }),
    );
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function renderBoatDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [
        {
          kind: "key-value-list",
          items: labeledFieldItems(f, resourceTypes, resource.resourceTypeId),
        },
      ],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    resourceTypes,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length > 0) {
    sections.push({
      kind: "section",
      title: "Connect",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      resource.resourceTypeId === "sandbox" ? f["size"] : undefined,
      resource.resourceTypeId === "sandbox" ? resource.externalId : undefined,
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
}

export function renderBoatSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
