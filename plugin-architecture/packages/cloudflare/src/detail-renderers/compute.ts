import type { ResourceInstance, DetailViewSchema, SectionNode } from "@infrawrench/plugin-base";
import { deploymentStatus } from "./status.js";

export function renderWorkerDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Worker Script",
    status: { kind: "status-dot", status: "healthy", label: "Deployed" },
    sections: [
      {
        kind: "section",
        title: "Worker Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              ...(fields["compatibilityDate"]
                ? [{ key: "Compatibility Date", value: String(fields["compatibilityDate"]) }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
              ...(fields["modifiedOn"]
                ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
                : []),
              ...(fields["routes"] ? [{ key: "Routes", value: String(fields["routes"]) }] : []),
            ],
          },
        ],
      },
    ],
    manifestEditor: { language: "json", resourceKind: "Worker Settings", readOnly: true },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderWorkersAiModelDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const name = String(fields["name"] ?? resource.displayName);
  const description = String(fields["description"] ?? "");
  return {
    title: name,
    subtitle: "Workers AI Model",
    // Models have no lifecycle state — they're always available to call.
    status: { kind: "status-dot", status: "healthy", label: "Available" },
    sections: [
      {
        kind: "section",
        title: "Model Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model", value: name, copyable: true },
              { key: "Task", value: String(fields["task"] ?? "Text Generation") },
              ...(description ? [{ key: "Description", value: description }] : []),
            ],
          },
        ],
      },
    ],
    // Host auto-renders a "Playground" tab whenever chatPanel is set. No
    // disabledReason — Workers AI models are always callable.
    chatPanel: {
      tabLabel: "Playground",
      subtitle: `Chat with ${name}`,
      greeting:
        "Hi! This is the Workers AI model playground — send a prompt to see how it responds. The full conversation history is sent on each turn.",
      inputPlaceholder: "Send a message…",
    },
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderPagesProjectDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const latestStatus = String(fields["latestDeploymentStatus"] ?? "");

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Project Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
            { key: "Subdomain", value: String(fields["subdomain"] ?? ""), copyable: true },
            ...(fields["productionBranch"]
              ? [{ key: "Production Branch", value: String(fields["productionBranch"]) }]
              : []),
            ...(fields["framework"]
              ? [{ key: "Framework", value: String(fields["framework"]) }]
              : []),
            ...(fields["domains"]
              ? [{ key: "Custom Domains", value: String(fields["domains"]) }]
              : []),
          ],
        },
      ],
    },
  ];

  if (latestStatus || fields["latestDeploymentUrl"]) {
    sections.push({
      kind: "section",
      title: "Latest Deployment",
      children: [
        {
          kind: "key-value-list",
          items: [
            ...(latestStatus ? [{ key: "Status", value: latestStatus }] : []),
            ...(fields["latestDeploymentUrl"]
              ? [{ key: "URL", value: String(fields["latestDeploymentUrl"]), copyable: true }]
              : []),
          ],
        },
      ],
    });
  }

  return {
    title: resource.displayName,
    subtitle: "Pages Project",
    status: latestStatus
      ? { kind: "status-dot", status: deploymentStatus(latestStatus), label: latestStatus }
      : { kind: "status-dot", status: "info" },
    sections,
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ...(fields["subdomain"]
        ? [
            {
              kind: "action" as const,
              label: "Open Site",
              action: {
                type: "open-url" as const,
                url: `https://${String(fields["subdomain"])}`,
              },
            },
          ]
        : []),
    ],
  };
}

export function renderPagesDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: `${String(fields["environment"] ?? "")} Deployment`,
    subtitle: String(fields["branch"] ?? ""),
    status: { kind: "status-dot", status: deploymentStatus(status), label: status },
    sections: [
      {
        kind: "section",
        title: "Deployment Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Environment", value: String(fields["environment"] ?? "") },
              { key: "Status", value: status },
              ...(fields["branch"] ? [{ key: "Branch", value: String(fields["branch"]) }] : []),
              ...(fields["commitHash"]
                ? [
                    {
                      key: "Commit",
                      value: String(fields["commitHash"]).slice(0, 8),
                      copyable: true,
                    },
                  ]
                : []),
              ...(fields["commitMessage"]
                ? [{ key: "Message", value: String(fields["commitMessage"]) }]
                : []),
              ...(fields["url"]
                ? [{ key: "URL", value: String(fields["url"]), copyable: true }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ...(fields["url"]
        ? [
            {
              kind: "action" as const,
              label: "Open",
              action: { type: "open-url" as const, url: String(fields["url"]) },
            },
          ]
        : []),
    ],
  };
}

export function renderWorkerRouteDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Worker Route",
    status: {
      kind: "status-dot",
      status: fields["script"] ? "healthy" : "info",
      label: fields["script"] ? "Routed" : "No Script",
    },
    sections: [
      {
        kind: "section",
        title: "Route Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Pattern", value: String(fields["pattern"] ?? ""), copyable: true },
              ...(fields["script"]
                ? [{ key: "Worker Script", value: String(fields["script"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
