/**
 * Detail renderer for Cloud Armor security policies.
 */
import type {
  DetailViewSchema,
  HostAction,
  ResourceInstance,
  SectionNode,
} from "@infrawrench/plugin-base";

/** Apply the Cloud Armor policy renderer to `base`. */
export function renderCloudArmorPolicy(resource: ResourceInstance, base: DetailViewSchema): void {
  base.subtitle = "Cloud Armor security policy";
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  base.logs = { defaultTailLines: 200 };

  interface ArmorRule {
    priority: number;
    description: string;
    action: string;
    preview: boolean;
    mode: "basic" | "advanced";
    match: string;
    responseCode: string;
  }
  interface ArmorPolicyFull {
    rules?: ArmorRule[];
    fingerprint?: string;
    error?: string;
  }
  interface ArmorTarget {
    name: string;
    region: string;
  }
  interface ArmorTargets {
    targets?: ArmorTarget[];
    error?: string;
  }

  const parseJson = <T>(raw: unknown, fallback: T): T => {
    const s = String(raw ?? "");
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  const policyData = parseJson<ArmorPolicyFull>(
    resource.resolvedOutputs["cloudArmorPolicyFull"],
    {},
  );
  const targetsData = parseJson<ArmorTargets>(resource.resolvedOutputs["cloudArmorTargets"], {});
  const rules = policyData.rules ?? [];
  const targets = targetsData.targets ?? [];

  const actionLabel = (action: string): string => {
    if (action === "allow") return "Allow";
    const m = /^deny\((\d+)\)$/.exec(action);
    if (m) return `Deny (${m[1]})`;
    return action || "—";
  };

  const addRuleAction: HostAction = {
    type: "prompt-nosql-command",
    command: "addRule",
    title: "Add rule",
    description:
      "Rules tell your security policy what to do. When the condition is met, the action will occur.",
    fields: [
      {
        key: "description",
        label: "Description",
        kind: "text",
        required: false,
        multiline: true,
      },
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        required: true,
        defaultValue: "basic",
        options: [
          { id: "basic", label: "Basic mode (IP addresses/ranges only)" },
          { id: "advanced", label: "Advanced mode" },
        ],
      },
      {
        key: "match",
        label: "Match",
        kind: "text",
        required: true,
        multiline: true,
        placeholder: "1.1.1.0/24, 1.2.0.0",
        description:
          "Up to 10 IP addresses or ranges, comma-separated. Use * to match all IPs. Advanced mode accepts a CEL expression.",
      },
      {
        key: "action",
        label: "Action",
        kind: "select",
        required: true,
        defaultValue: "deny",
        options: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      },
      {
        key: "responseCode",
        label: "Response code",
        kind: "select",
        required: false,
        defaultValue: "403",
        showWhen: { fieldKey: "action", fieldValue: "deny" },
        options: [
          { id: "403", label: "403 (Forbidden)" },
          { id: "404", label: "404 (Not Found)" },
          { id: "502", label: "502 (Bad Gateway)" },
        ],
      },
      {
        key: "preview",
        label: "Enable preview only",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "false", label: "Off" },
          { id: "true", label: "On — log but don't enforce" },
        ],
      },
      {
        key: "priority",
        label: "Priority",
        kind: "number",
        required: true,
        defaultValue: "1000",
        minValue: 0,
        maxValue: 2147483647,
        description: "Priority is evaluated from 0 (highest) to 2,147,483,647 (lowest).",
      },
    ],
    submitLabel: "Add",
  };

  const rulesSection: SectionNode = {
    kind: "section",
    title: "Rules",
    children: [],
  };
  if (policyData.error) {
    rulesSection.children.push({
      kind: "text",
      content: `Could not load rules: ${policyData.error}`,
      variant: "muted",
    });
  } else if (rules.length === 0) {
    rulesSection.children.push({
      kind: "text",
      content: "No rules defined yet.",
      variant: "muted",
    });
  } else {
    rulesSection.children.push({
      kind: "table",
      columns: [
        { key: "priority", label: "Priority", width: "narrow" },
        { key: "description", label: "Description" },
        { key: "mode", label: "Mode", width: "narrow" },
        { key: "match", label: "Match", mono: true, width: "wide" },
        { key: "action", label: "Action", width: "narrow" },
        { key: "preview", label: "Preview", width: "narrow" },
        { key: "delete", label: "", width: "narrow" },
      ],
      rows: rules.map((r) => ({
        cells: {
          priority: String(r.priority),
          description: r.description || "—",
          mode: r.mode === "basic" ? "Basic" : "Advanced",
          match: r.match || "—",
          action: actionLabel(r.action),
          preview: r.preview ? "Yes" : "—",
          delete: {
            kind: "action",
            label: "Delete",
            variant: "ghost",
            action: {
              type: "prompt-nosql-command",
              command: "deleteRule",
              title: `Delete rule with priority ${r.priority}?`,
              description: r.description
                ? `"${r.description}" will be removed from the policy.`
                : "This rule will be removed from the policy.",
              fields: [
                {
                  key: "priority",
                  label: "Priority",
                  kind: "number",
                  required: true,
                  defaultValue: String(r.priority),
                  hidden: true,
                },
              ],
              submitLabel: "Delete",
              danger: true,
            },
          },
        },
      })),
    });
  }
  rulesSection.children.push({ kind: "action", label: "Add rule", action: addRuleAction });

  const addTargetAction: HostAction = {
    type: "prompt-nosql-command",
    command: "addTarget",
    title: "Apply policy to new target",
    description:
      "Targets are Google Cloud resources that you want to control access to. Use external load balancer backend services as targets.",
    fields: [
      {
        key: "backendService",
        label: "Backend service",
        kind: "resource-picker",
        required: true,
        associationSources: [
          { pluginId: "gcp", resourceTypeId: "backend-service", outputKey: "name" },
        ],
      },
    ],
    submitLabel: "Add",
  };

  const targetsSection: SectionNode = {
    kind: "section",
    title: "Targets",
    children: [],
  };
  if (targetsData.error) {
    targetsSection.children.push({
      kind: "text",
      content: `Could not load targets: ${targetsData.error}`,
      variant: "muted",
    });
  } else if (targets.length === 0) {
    targetsSection.children.push({
      kind: "text",
      content: "No backend services use this policy yet.",
      variant: "muted",
    });
  } else {
    targetsSection.children.push({
      kind: "table",
      columns: [
        { key: "name", label: "Backend service", mono: true },
        { key: "region", label: "Region", width: "narrow" },
        { key: "remove", label: "", width: "narrow" },
      ],
      rows: targets.map((t) => ({
        cells: {
          name: t.name,
          region: t.region || "global",
          remove: {
            kind: "action",
            label: "Detach",
            variant: "ghost",
            action: {
              type: "prompt-nosql-command",
              command: "removeTarget",
              title: `Detach ${t.name} from this policy?`,
              description: "The backend service will no longer be protected by this policy.",
              fields: [
                {
                  key: "backendService",
                  label: "Backend service",
                  kind: "text",
                  required: true,
                  defaultValue: t.name,
                  hidden: true,
                },
                {
                  key: "region",
                  label: "Region",
                  kind: "text",
                  required: false,
                  defaultValue: t.region,
                  hidden: true,
                },
              ],
              submitLabel: "Detach",
              danger: true,
            },
          },
        },
      })),
    });
  }
  targetsSection.children.push({ kind: "action", label: "Add target", action: addTargetAction });

  base.sections = [...base.sections, rulesSection, targetsSection];
}
