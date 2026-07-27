/** Detail view for DigitalOcean Gradient AI knowledge bases and their data sources. */
import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { SPACES_REGIONS } from "../constants.js";
import { parseJsonArray } from "./shared.js";

/**
 * Knowledge base detail page: data-source management (add Spaces/web
 * sources, per-source reindex/remove), an indexing-job history table, and
 * the hybrid retrieval endpoint. The data-source + job lists are populated
 * by `enrichGenAiKnowledgeBase`; actions flow through `executeNoSqlCommand`.
 */
export function applyGenAiKnowledgeBaseDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  const outputs = resource.resolvedOutputs ?? {};

  interface DataSourceRow {
    uuid?: string;
    type?: string;
    summary?: string;
    status?: string;
    created_at?: string;
  }
  interface JobRow {
    uuid?: string;
    status?: string;
    phase?: string;
    total_datasources?: number;
    completed_datasources?: number;
    tokens?: string;
    created_at?: string;
    finished_at?: string;
  }
  interface BucketOpt {
    name?: string;
    region?: string;
  }
  const dataSources = parseJsonArray<DataSourceRow>(outputs["__dataSources__"]);
  const jobs = parseJsonArray<JobRow>(outputs["__indexingJobs__"]);
  const buckets = parseJsonArray<BucketOpt>(outputs["__spacesBuckets__"]);

  const formatIndexStatus = (raw: string): string => {
    switch (raw) {
      case "INDEX_JOB_STATUS_COMPLETED":
        return "Completed";
      case "INDEX_JOB_STATUS_IN_PROGRESS":
        return "Indexing";
      case "INDEX_JOB_STATUS_PENDING":
        return "Pending";
      case "INDEX_JOB_STATUS_FAILED":
        return "Failed";
      case "INDEX_JOB_STATUS_CANCELLED":
        return "Cancelled";
      case "INDEX_JOB_STATUS_PARTIAL":
        return "Partial";
      case "INDEX_JOB_STATUS_NO_CHANGES":
        return "No changes";
      default:
        return raw ? raw.replace(/^INDEX_JOB_STATUS_/, "") : "—";
    }
  };

  // The Spaces source can be picked from the account's actual buckets
  // (a resource selector — submits the bucket's `bucketRef` output =
  // `name|region`) or typed by hand. A `bucketSource` toggle gates the
  // two; default to "pick" when we discovered buckets during enrich,
  // otherwise "manual" (no Spaces keys → nothing to pick). Both pick and
  // manual fields are `required: false` because only one is visible at a
  // time; the handler validates the resolved bucket name + region.
  const hasBuckets = buckets.some((b) => b.name);
  const spacesSourceFields: CreateFieldConfig[] = [
    {
      key: "bucketSource",
      label: "Bucket source",
      kind: "select",
      required: true,
      defaultValue: hasBuckets ? "pick" : "manual",
      options: [
        { id: "pick", label: "Pick from my Spaces buckets" },
        { id: "manual", label: "Enter bucket name manually" },
      ],
      ...(hasBuckets
        ? {}
        : {
            description:
              "No Spaces buckets are listable — add Spaces API keys to this account to pick from a list.",
          }),
    },
    {
      // Resource selector — lists the account's Spaces buckets and submits
      // the chosen bucket's `bucketRef` output (`name|region`), which the
      // handler splits back apart.
      key: "spacesBucket",
      label: "Spaces bucket",
      kind: "resource-picker",
      required: false,
      associationSources: [
        { pluginId: "digitalocean", resourceTypeId: "spaces-bucket", outputKey: "bucketRef" },
      ],
      showWhen: { fieldKey: "bucketSource", fieldValue: "pick" },
    },
    {
      key: "spacesBucketName",
      label: "Spaces bucket name",
      kind: "text",
      required: false,
      description: "Name of the DigitalOcean Spaces bucket to index.",
      showWhen: { fieldKey: "bucketSource", fieldValue: "manual" },
    },
    {
      key: "spacesRegion",
      label: "Bucket region",
      kind: "region-picker",
      required: false,
      regions: SPACES_REGIONS.map((r) => ({ id: r, label: r })),
      ...(SPACES_REGIONS[0] ? { defaultValue: SPACES_REGIONS[0] } : {}),
      showWhen: { fieldKey: "bucketSource", fieldValue: "manual" },
    },
  ];

  detail.headerActions = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    {
      kind: "action",
      label: "Reindex all",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "start-indexing",
        title: "Reindex all data sources",
        description:
          dataSources.length === 0
            ? "This knowledge base has no data sources yet. Add a Spaces bucket or web source first."
            : "Start an indexing job over every data source in this knowledge base. Existing embeddings stay queryable while the job runs.",
        ...(dataSources.length === 0
          ? { descriptionVariant: "error" as const, blocked: true }
          : { submitLabel: "Reindex all" }),
        fields: [],
      },
    },
    {
      kind: "action",
      label: "+ Add Spaces source",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "add-spaces-source",
        title: "Add Spaces bucket data source",
        description:
          "Index files stored in a DigitalOcean Spaces bucket. Indexing starts automatically after the source is added.",
        submitLabel: "Add source",
        fields: [
          ...spacesSourceFields,
          {
            key: "itemPath",
            label: "Folder / object path",
            kind: "text",
            required: false,
            description: "Optional path within the bucket to scope indexing (e.g. `docs/`).",
          },
        ],
      },
    },
    {
      kind: "action",
      label: "+ Add web source",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "add-web-source",
        title: "Add web crawler data source",
        description:
          "Crawl a public website and index its pages (up to 5,500). Indexing starts automatically after the source is added.",
        submitLabel: "Add source",
        fields: [
          {
            key: "baseUrl",
            label: "Base URL",
            kind: "text",
            required: true,
            description: "Seed URL to crawl, e.g. https://example.com/docs.",
          },
          {
            key: "crawlingOption",
            label: "Crawl scope",
            kind: "select",
            required: true,
            options: [
              { id: "SCOPED", label: "Scoped — only the base URL" },
              { id: "PATH", label: "Path — base URL + pages under its path" },
              { id: "DOMAIN", label: "Domain — base URL + same-domain pages" },
              { id: "SUBDOMAINS", label: "Subdomains — base URL + any subdomain" },
              { id: "SITEMAP", label: "Sitemap — URLs discovered in the sitemap" },
            ],
            defaultValue: "SCOPED",
          },
          {
            key: "embedMedia",
            label: "Index media (images, etc.)",
            kind: "select",
            required: false,
            options: [
              { id: "no", label: "No" },
              { id: "yes", label: "Yes" },
            ],
            defaultValue: "no",
          },
        ],
      },
    },
  ];

  // Retrieval endpoint — copyable so the user can wire it into their own
  // RAG client without hunting through DO's console.
  const retrieval = String(outputs["retrievalEndpoint"] ?? "");
  if (retrieval) {
    detail.sections.push({
      kind: "section",
      title: "Retrieval",
      children: [
        {
          kind: "key-value-list",
          items: [{ key: "Hybrid retrieval endpoint", value: retrieval, copyable: true }],
        },
      ],
    });
  }

  // Data sources table — per-row Reindex + Remove actions.
  if (dataSources.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Data Sources",
      children: [
        {
          kind: "table",
          columns: [
            { key: "type", label: "Type" },
            { key: "summary", label: "Source" },
            { key: "status", label: "Last index" },
            { key: "reindex", label: "", width: "narrow" },
            { key: "remove", label: "", width: "narrow" },
          ],
          rows: dataSources.map((d) => ({
            cells: {
              type: String(d.type ?? ""),
              summary: String(d.summary ?? ""),
              status: formatIndexStatus(String(d.status ?? "")),
              reindex: {
                kind: "action",
                label: "Reindex",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "reindex-source",
                  title: "Reindex data source",
                  description: `Start an indexing job for "${d.summary ?? d.uuid}"?`,
                  submitLabel: "Reindex",
                  fields: [
                    {
                      key: "dataSourceUuid",
                      label: "Data Source UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(d.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
              remove: {
                kind: "action",
                label: "Remove",
                variant: "ghost",
                action: {
                  type: "prompt-nosql-command",
                  command: "remove-data-source",
                  title: "Remove data source",
                  description: `Remove "${d.summary ?? d.uuid}" from this knowledge base? Its indexed embeddings will be deleted on the next index.`,
                  submitLabel: "Remove",
                  danger: true,
                  fields: [
                    {
                      key: "dataSourceUuid",
                      label: "Data Source UUID",
                      kind: "text",
                      required: true,
                      hidden: true,
                      defaultValue: String(d.uuid ?? ""),
                    },
                  ],
                },
              } as ActionNode,
            },
          })),
        },
      ],
    });
  } else {
    detail.sections.push({
      kind: "section",
      title: "Data Sources",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "No data sources yet. Use '+ Add Spaces source' or '+ Add web source' above to index content into this knowledge base.",
        },
      ],
    });
  }

  // Indexing jobs history — most-recent first. Includes a Cancel action for
  // jobs that are still pending/in-progress.
  if (jobs.length > 0) {
    detail.sections.push({
      kind: "section",
      title: "Indexing Jobs",
      children: [
        {
          kind: "table",
          columns: [
            { key: "status", label: "Status" },
            { key: "progress", label: "Sources" },
            { key: "tokens", label: "Tokens" },
            { key: "created", label: "Started" },
            { key: "action", label: "", width: "narrow" },
          ],
          rows: jobs.map((j) => {
            const status = String(j.status ?? "");
            const running =
              status === "INDEX_JOB_STATUS_IN_PROGRESS" || status === "INDEX_JOB_STATUS_PENDING";
            return {
              cells: {
                status: formatIndexStatus(status),
                progress: `${j.completed_datasources ?? 0}/${j.total_datasources ?? 0}`,
                tokens: String(j.tokens ?? ""),
                created: String(j.created_at ?? ""),
                action: running
                  ? ({
                      kind: "action",
                      label: "Cancel",
                      variant: "ghost",
                      action: {
                        type: "prompt-nosql-command",
                        command: "cancel-indexing",
                        title: "Cancel indexing job",
                        description: "Cancel this running indexing job?",
                        submitLabel: "Cancel job",
                        danger: true,
                        fields: [
                          {
                            key: "jobUuid",
                            label: "Job UUID",
                            kind: "text",
                            required: true,
                            hidden: true,
                            defaultValue: String(j.uuid ?? ""),
                          },
                        ],
                      },
                    } as ActionNode)
                  : "",
              },
            };
          }),
        },
      ],
    });
  }
}
