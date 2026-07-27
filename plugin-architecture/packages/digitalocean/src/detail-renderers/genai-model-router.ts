/** Detail view for DigitalOcean Gradient AI model routers. */
import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { parseJsonArray } from "./shared.js";

/**
 * Inference-router detail page: a "Routing Policies" table (task → models →
 * selection preference) and a "Fallback Models" section. Both are read from
 * the router's `config`, stashed as `__policies__` / `__fallbackModels__`
 * during listGenAiModelRouters.
 */
export function applyGenAiModelRouterDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  const outputs = resource.resolvedOutputs ?? {};
  interface PolicyModel {
    id?: string;
    name?: string;
  }
  interface Policy {
    task?: string;
    prefer?: string;
    models?: PolicyModel[];
  }
  interface TaskPreset {
    task_slug?: string;
    name?: string;
    models?: string[];
    prefer?: string;
  }
  const policies = parseJsonArray<Policy>(outputs["__policies__"]);
  const fallback = parseJsonArray<PolicyModel>(outputs["__fallbackModels__"]);
  const taskPresets = parseJsonArray<TaskPreset>(outputs["__taskPresets__"]);
  const modelOptions = parseJsonArray<{ id?: string; label?: string }>(
    outputs["__routerModelOptions__"],
  );

  const modelLabel = (m: PolicyModel): string => {
    const name = String(m.name ?? "").trim();
    const id = String(m.id ?? "").trim();
    if (name && id) return `${name}`;
    return name || id || "—";
  };
  const preferLabel = (p: string): string => {
    switch (p) {
      case "cheapest":
        return "Cheapest";
      case "fastest":
        return "Fastest";
      case "none":
      case "":
        return "Balanced";
      default:
        return p;
    }
  };

  // Pickers shared by the Add and per-row Edit policy forms.
  const taskOptions = taskPresets
    .filter((t) => t.task_slug)
    .map((t) => ({ id: String(t.task_slug), label: String(t.name ?? t.task_slug) }));
  const preferOptions = [
    { id: "none", label: "Balanced (default)" },
    { id: "cheapest", label: "Cheapest" },
    { id: "fastest", label: "Fastest" },
  ];
  const modelPolicyOptions = modelOptions
    .filter((o) => o.id)
    .map((o) => ({ id: String(o.id), label: String(o.label ?? o.id) }));
  const canEditPolicies = taskOptions.length > 0;

  // Build the field set for the add/edit policy prompt. `originalTask` is a
  // hidden marker the handler uses to replace the right policy on edit.
  const policyFields = (
    preset: { task?: string; prefer?: string; modelIds?: string[] } = {},
  ): CreateFieldConfig[] => [
    {
      key: "originalTask",
      label: "",
      kind: "text",
      required: false,
      hidden: true,
      defaultValue: preset.task ?? "",
    },
    {
      key: "task",
      label: "Task",
      kind: "select",
      required: true,
      options: taskOptions,
      ...((preset.task ?? taskOptions[0]?.id)
        ? { defaultValue: preset.task ?? taskOptions[0]!.id }
        : {}),
      description: "Which kind of request this policy routes.",
    },
    {
      key: "prefer",
      label: "Selection preference",
      kind: "select",
      required: true,
      options: preferOptions,
      defaultValue: preset.prefer && preset.prefer !== "" ? preset.prefer : "none",
    },
    {
      key: "modelIds",
      label: "Models",
      kind: "policy-picker",
      required: false,
      policies: modelPolicyOptions.map((o) => ({
        id: o.id,
        label: o.label,
        category: "Router-eligible models",
      })),
      ...(preset.modelIds && preset.modelIds.length > 0
        ? { defaultValue: JSON.stringify(preset.modelIds) }
        : {}),
      description:
        "Models this task may route to. Leave empty to use the task's recommended default models.",
    },
  ];

  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: "+ Add policy",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "save-router-policy",
        title: "Add routing policy",
        ...(canEditPolicies
          ? {
              description:
                "Route a class of requests to specific models with a cost/latency preference.",
            }
          : {
              description: "No router task presets are available on this account.",
              descriptionVariant: "error" as const,
              blocked: true,
            }),
        fields: canEditPolicies ? policyFields() : [],
      },
    },
  ];

  if (policies.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Routing Policies",
      children: [
        {
          kind: "table",
          columns: [
            { key: "task", label: "Task" },
            { key: "models", label: "Models" },
            { key: "prefer", label: "Prefers", width: "narrow" },
            { key: "edit", label: "", width: "narrow" },
            { key: "remove", label: "", width: "narrow" },
          ],
          rows: policies.map((p) => {
            const taskSlug = String(p.task ?? "");
            const modelIds = (p.models ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
            const editAction: ActionNode | string = canEditPolicies
              ? {
                  kind: "action",
                  label: "Edit",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "save-router-policy",
                    title: `Edit policy: ${taskSlug || "default"}`,
                    submitLabel: "Save",
                    fields: policyFields({
                      task: taskSlug,
                      prefer: String(p.prefer ?? ""),
                      modelIds,
                    }),
                  },
                }
              : "";
            return {
              cells: {
                task: taskSlug || "Default",
                models: (p.models ?? []).map(modelLabel).join(", ") || "—",
                prefer: preferLabel(String(p.prefer ?? "")),
                edit: editAction,
                remove: {
                  kind: "action",
                  label: "Remove",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "remove-router-policy",
                    title: "Remove routing policy",
                    description: `Remove the "${taskSlug || "default"}" policy? Requests for this task fall through to the fallback models.`,
                    submitLabel: "Remove",
                    danger: true,
                    fields: [
                      {
                        key: "task",
                        label: "Task",
                        kind: "text",
                        required: true,
                        hidden: true,
                        defaultValue: taskSlug,
                      },
                    ],
                  },
                } as ActionNode,
              },
            };
          }),
        },
      ],
    });
  } else {
    detail.sections.push({
      kind: "section",
      title: "Routing Policies",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "No per-task routing policies configured. Requests fall through to the fallback models — use “+ Add policy” to route specific tasks to specific models.",
        },
      ],
    });
  }

  detail.sections.push({
    kind: "section",
    title: "Fallback Models",
    children: [
      fallback.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "model", label: "Model" },
              { key: "id", label: "ID", mono: true },
            ],
            rows: fallback.map((m) => ({
              cells: { model: modelLabel(m), id: String(m.id ?? "") },
            })),
          }
        : {
            kind: "text",
            variant: "muted",
            content: "No fallback models set.",
          },
    ],
  });
}
