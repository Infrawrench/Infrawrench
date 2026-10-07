import type {
  CreateFieldConfig,
  CreateResourceConfig,
  RegionOption,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { computeDescription, computeLabel } from "./mappers.js";
import type { CatalogList, HardwareFlavor, RepoInfo, Vendors } from "./wire.js";

/** Inference Endpoints tasks, from the `EndpointTask` enum in the v2 spec. */
export const ENDPOINT_TASKS = [
  "text-generation",
  "image-text-to-text",
  "feature-extraction",
  "sentence-embeddings",
  "sentence-similarity",
  "sentence-ranking",
  "text-ranking",
  "text-classification",
  "token-classification",
  "zero-shot-classification",
  "question-answering",
  "table-question-answering",
  "fill-mask",
  "summarization",
  "translation",
  "automatic-speech-recognition",
  "audio-classification",
  "image-classification",
  "image-segmentation",
  "object-detection",
  "text-to-image",
  "any-to-any",
  "custom",
];

const VENDOR_LABELS: Record<string, string> = { aws: "AWS", gcp: "Google Cloud", azure: "Azure" };

/** Space sleep-time choices, in seconds. -1 keeps the Space awake. */
export const SLEEP_OPTIONS: SelectOption[] = [
  { id: "300", label: "5 minutes" },
  { id: "900", label: "15 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "36000", label: "10 hours" },
  { id: "86400", label: "24 hours" },
  { id: "172800", label: "48 hours" },
  { id: "259200", label: "72 hours" },
  { id: "-1", label: "Never sleep" },
];

export function flavorOptions(flavors: HardwareFlavor[]): SelectOption[] {
  return flavors
    .filter((f) => f.name)
    .map((f) => {
      const accel = f.accelerator?.model
        ? `${f.accelerator.quantity && f.accelerator.quantity !== "1" ? `${f.accelerator.quantity}× ` : ""}${f.accelerator.model}${f.accelerator.vram ? ` ${f.accelerator.vram}` : ""}`
        : "";
      const price =
        typeof f.unitCostUSD === "number"
          ? f.unitCostUSD === 0
            ? "free"
            : `$${(f.unitCostUSD * (f.unitLabel === "minute" ? 60 : 1)).toFixed(2)}/h`
          : "";
      return {
        id: String(f.name),
        label: f.prettyName || String(f.name),
        description: [f.cpu, f.ram, accel, price].filter((p) => p && p !== "-").join(" · "),
      };
    });
}

interface CreateInputs {
  vendors?: Vendors;
  catalog?: CatalogList;
  ownModels?: RepoInfo[];
  trending?: RepoInfo[];
  spaceHardware?: HardwareFlavor[];
  jobHardware?: HardwareFlavor[];
  ownSpaces?: RepoInfo[];
  namespace?: string;
}

const NAME_DESCRIPTION = "Lowercase letters, digits and hyphens.";

export function buildCreateConfig(typeId: string, inputs: CreateInputs): CreateResourceConfig {
  switch (typeId) {
    case "hf-inference-endpoint":
      return endpointConfig(inputs);
    case "hf-model":
    case "hf-dataset":
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: typeId === "hf-model" ? "my-model" : "my-dataset",
            description: `Created as ${inputs.namespace ?? "your namespace"}/<name>.`,
          },
          visibilityField(false),
          storageRegionField(),
        ],
      };
    case "hf-space":
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "my-space",
            description: `Created as ${inputs.namespace ?? "your namespace"}/<name>.`,
          },
          {
            key: "sdk",
            label: "SDK",
            kind: "select",
            required: true,
            defaultValue: "gradio",
            options: [
              {
                id: "gradio",
                label: "Gradio",
                description: "Python UI apps; required for ZeroGPU",
              },
              {
                id: "docker",
                label: "Docker",
                description: "Any container listening on port 7860",
              },
              { id: "static", label: "Static", description: "Plain HTML, always free" },
            ],
          },
          {
            key: "hardware",
            label: "Hardware",
            kind: "select",
            required: false,
            defaultValue: "cpu-basic",
            options: flavorOptions(inputs.spaceHardware ?? []),
            description:
              "Free cpu-basic needs a PRO or Team plan for Gradio and Docker Spaces. Paid hardware needs a payment method.",
            showWhen: { fieldKey: "sdk", fieldValuesNot: ["static"] },
          },
          {
            key: "sleepTimeSeconds",
            label: "Sleep After",
            kind: "select",
            required: false,
            defaultValue: "3600",
            options: SLEEP_OPTIONS,
            description: "Paid hardware only: you are not billed while the Space sleeps.",
            showWhen: { fieldKey: "hardware", fieldValuesNot: ["cpu-basic", "zero-a10g"] },
          },
          visibilityField(true),
          {
            key: "shortDescription",
            label: "Short Description",
            kind: "text",
            required: false,
            placeholder: "What this Space does (60 characters max)",
          },
        ],
      };
    case "hf-job":
    case "hf-scheduled-job":
      return jobConfig(typeId, inputs);
    case "hf-service-account":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "ci-bot" },
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: false,
            placeholder: "What uses this account",
          },
        ],
      };
    default:
      return { fields: [] };
  }
}

function visibilityField(space: boolean): CreateFieldConfig {
  return {
    key: "visibility",
    label: "Visibility",
    kind: "select",
    required: true,
    defaultValue: "private",
    options: [
      { id: "private", label: "Private", description: "Only you or your organization" },
      { id: "public", label: "Public", description: "Anyone can see it" },
      ...(space
        ? [
            {
              id: "protected",
              label: "Protected",
              description: "The app is public, the code and files stay private",
            },
          ]
        : []),
    ],
  };
}

function storageRegionField(): CreateFieldConfig {
  return {
    key: "region",
    label: "Storage Region",
    kind: "select",
    required: false,
    defaultValue: "",
    options: [
      { id: "", label: "Default" },
      { id: "us", label: "United States" },
      { id: "eu", label: "Europe", description: "Enterprise organizations only" },
    ],
  };
}

function endpointConfig(inputs: CreateInputs): CreateResourceConfig {
  const regions: RegionOption[] = [];
  const sizes: SizeOption[] = [];
  for (const vendor of inputs.vendors?.vendors ?? []) {
    if (vendor.status === "not_available") continue;
    for (const region of vendor.regions ?? []) {
      if (region.status === "not_available") continue;
      const location = `${vendor.name}/${region.name}`;
      const computes = (region.computes ?? []).filter(
        (c) => c.id && c.status !== "not_available" && c.status !== "deprecated",
      );
      if (computes.length === 0) continue;
      regions.push({
        id: location,
        label: String(region.name),
        location: `${VENDOR_LABELS[String(vendor.name)] ?? vendor.name} · ${region.label ?? region.name}`,
      });
      for (const c of computes) {
        sizes.push({
          id: String(c.id),
          label: computeLabel(c),
          vcpus: c.numCpus ?? 0,
          memoryMb: Math.round((c.memoryGb ?? 0) * 1024),
          ...(typeof c.pricePerHour === "number"
            ? { priceMonthly: Math.round(c.pricePerHour * 730 * 100) / 100 }
            : {}),
          category: (c.accelerator ?? "cpu").toUpperCase(),
          availableFor: [location],
        });
      }
    }
  }

  const recipes: SelectOption[] = [];
  for (const item of inputs.catalog?.items ?? []) {
    for (const recipe of item.recipes ?? []) {
      if (!recipe.publicId) continue;
      recipes.push({
        id: recipe.publicId,
        label: item.repoId ?? item.modelName ?? recipe.publicId,
        description: [item.task, recipe.engineType, recipe.accelerator?.toUpperCase()]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }

  const seen = new Set<string>();
  const repos: SelectOption[] = [];
  for (const [list, group] of [
    [inputs.ownModels ?? [], "Yours"],
    [inputs.trending ?? [], "Trending"],
  ] as const) {
    for (const m of list) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      repos.push({
        id: m.id,
        label: m.id,
        description: [group, m.pipeline_tag].filter(Boolean).join(" · "),
      });
    }
  }
  repos.push({ id: "__other__", label: "Another model…", description: "Type any Hub model id" });

  return {
    fields: [
      {
        key: "name",
        label: "Name",
        kind: "text",
        required: true,
        placeholder: "my-endpoint",
        description: `${NAME_DESCRIPTION} 32 characters at most.`,
      },
      {
        key: "source",
        label: "Configuration",
        kind: "select",
        required: true,
        defaultValue: recipes.length ? "catalog" : "custom",
        options: [
          {
            id: "catalog",
            label: "From the Inference Catalog",
            description: "A tested engine and hardware chosen by Hugging Face",
          },
          {
            id: "custom",
            label: "Custom",
            description: "Pick the model, cloud, region and hardware",
          },
        ],
      },
      {
        key: "recipe",
        label: "Catalog Model",
        kind: "select",
        required: true,
        options: recipes,
        ...(recipes[0] ? { defaultValue: recipes[0].id } : {}),
        showWhen: { fieldKey: "source", fieldValue: "catalog" },
      },
      {
        key: "repository",
        label: "Model",
        kind: "select",
        required: true,
        options: repos,
        ...(repos[0] ? { defaultValue: repos[0].id } : {}),
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "repositoryOther",
        label: "Model ID",
        kind: "text",
        required: true,
        placeholder: "meta-llama/Llama-3.1-8B-Instruct",
        showWhen: {
          allOf: [
            { fieldKey: "source", fieldValue: "custom" },
            { fieldKey: "repository", fieldValue: "__other__" },
          ],
        },
      },
      {
        key: "task",
        label: "Task",
        kind: "select",
        required: true,
        defaultValue: "text-generation",
        options: ENDPOINT_TASKS.map((t) => ({ id: t, label: t })),
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "location",
        label: "Cloud and Region",
        kind: "region-picker",
        required: true,
        regions,
        ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        transient: true,
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "compute",
        label: "Hardware",
        kind: "size-picker",
        required: true,
        sizes,
        filterByFieldKey: "location",
        description: "Price is per replica. Monthly figures assume the replica runs all month.",
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "minReplica",
        label: "Min Replicas",
        kind: "number",
        required: true,
        defaultValue: "0",
        minValue: 0,
        maxValue: 100,
        description:
          "0 lets the endpoint scale to zero when idle, so it costs nothing until the next request.",
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "maxReplica",
        label: "Max Replicas",
        kind: "number",
        required: true,
        defaultValue: "1",
        minValue: 1,
        maxValue: 100,
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "scaleToZeroTimeout",
        label: "Scale to Zero After (minutes)",
        kind: "number",
        required: false,
        defaultValue: "15",
        minValue: 1,
        showWhen: {
          allOf: [
            { fieldKey: "source", fieldValue: "custom" },
            { fieldKey: "minReplica", fieldValue: "0" },
          ],
        },
      },
      {
        key: "type",
        label: "Security Level",
        kind: "select",
        required: true,
        defaultValue: "authenticated",
        options: [
          {
            id: "authenticated",
            label: "Protected",
            description: "Callers need a Hugging Face token with access to this namespace",
          },
          { id: "public", label: "Public", description: "Anyone with the URL can call it" },
          { id: "private", label: "Private", description: "AWS PrivateLink only" },
        ],
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "containerImage",
        label: "Custom Container Image (optional)",
        kind: "text",
        required: false,
        placeholder: "ghcr.io/acme/server:1.2",
        description: "Leave empty to let Hugging Face pick the serving container for the task.",
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "revision",
        label: "Revision (optional)",
        kind: "text",
        required: false,
        placeholder: "main",
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
      {
        key: "tags",
        label: "Tags (optional)",
        kind: "string-list",
        required: false,
        showWhen: { fieldKey: "source", fieldValue: "custom" },
      },
    ],
  };
}

function jobConfig(typeId: string, inputs: CreateInputs): CreateResourceConfig {
  const spaces: SelectOption[] = [
    { id: "__none__", label: "A Docker image", description: "Any public image or registry path" },
    ...(inputs.ownSpaces ?? [])
      .filter((s) => s.id)
      .map((s) => ({
        id: String(s.id),
        label: String(s.id),
        description: "Run this Space's image",
      })),
  ];
  const fields: CreateFieldConfig[] = [
    {
      key: "spaceId",
      label: "Run",
      kind: "select",
      required: true,
      defaultValue: "__none__",
      options: spaces,
    },
    {
      key: "image",
      label: "Docker Image",
      kind: "text",
      required: true,
      placeholder: "python:3.12",
      showWhen: { fieldKey: "spaceId", fieldValue: "__none__" },
    },
    {
      key: "command",
      label: "Command",
      kind: "text",
      required: false,
      placeholder: "python -c \"print('hello')\"",
      description: "Runs under /bin/sh -c. Leave empty to use the image's own entrypoint.",
    },
    {
      key: "flavor",
      label: "Hardware",
      kind: "select",
      required: true,
      defaultValue: "cpu-basic",
      options: flavorOptions(inputs.jobHardware ?? []),
      description: "Jobs are billed per minute of runtime.",
    },
    {
      key: "timeoutSeconds",
      label: "Timeout (seconds)",
      kind: "number",
      required: false,
      defaultValue: "1800",
      minValue: 60,
    },
    {
      key: "environment",
      label: "Environment (optional)",
      kind: "text",
      multiline: true,
      required: false,
      placeholder: "KEY=value\nOTHER=value",
    },
  ];
  if (typeId === "hf-scheduled-job") {
    fields.unshift({
      key: "schedule",
      label: "Schedule",
      kind: "select",
      required: true,
      defaultValue: "@daily",
      options: [
        { id: "@hourly", label: "Every hour" },
        { id: "@daily", label: "Every day (00:00 UTC)" },
        { id: "@weekly", label: "Every week" },
        { id: "@monthly", label: "Every month" },
        { id: "0 9 * * 1-5", label: "Weekdays at 09:00 UTC" },
        { id: "*/15 * * * *", label: "Every 15 minutes" },
      ],
      description: "Edit the schedule afterwards to use any cron expression.",
    });
    fields.push({
      key: "concurrency",
      label: "Allow Overlapping Runs",
      kind: "select",
      required: false,
      defaultValue: "false",
      options: [
        { id: "false", label: "No, skip a run while the previous one is going" },
        { id: "true", label: "Yes" },
      ],
    });
  }
  return { fields };
}
