import type { DetailViewSchema, KVItem, ResourceInstance } from "@infrawrench/plugin-base";

/**
 * Collections shapes and renderers. Collections live on the management host
 * (`https://management-api.x.ai`) and authenticate with the management key,
 * not the inference key.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/collections/collection
 */

const DASH = "—";

interface ChunkSize {
  max_chunk_size_chars?: number;
  chunk_overlap_chars?: number;
  max_chunk_size_tokens?: number;
  chunk_overlap_tokens?: number;
  max_chunk_size_bytes?: number;
  chunk_overlap_bytes?: number;
  encoding_name?: string;
}

export interface XaiChunkConfiguration {
  chars_configuration?: ChunkSize;
  tokens_configuration?: ChunkSize;
  table_configuration?: ChunkSize;
  markdown_tokens_configuration?: ChunkSize;
  markdown_chars_configuration?: ChunkSize;
  code_tokens_configuration?: ChunkSize;
  code_chars_configuration?: ChunkSize;
  bytes_configuration?: ChunkSize;
  strip_whitespace?: boolean;
  inject_name_into_chunks?: boolean;
}

export interface XaiFieldDefinition {
  key: string;
  required?: boolean;
  inject_into_chunk?: boolean;
  unique?: boolean;
  description?: string;
}

export interface XaiCollection {
  collection_id: string;
  collection_name?: string;
  created_at?: string;
  index_configuration?: { model_name?: string };
  chunk_configuration?: XaiChunkConfiguration;
  documents_count?: number;
  field_definitions?: XaiFieldDefinition[];
  collection_description?: string;
  collection_type?: string;
}

export interface XaiCollectionDocument {
  file_metadata?: {
    file_id?: string;
    name?: string;
    /** A string on the wire, despite being a byte count. */
    size_bytes?: string;
    content_type?: string;
    created_at?: string;
    expires_at?: string | null;
    hash?: string;
    upload_status?: string;
    upload_error_message?: string;
    processing_status?: string;
    file_path?: string;
  };
  fields?: Record<string, string>;
  status?: string;
  error_message?: string;
  last_indexed_at?: string;
}

/**
 * One readable line for whichever chunking strategy the collection uses.
 * xAI sets at most one of the `*_configuration` blocks.
 */
export function chunkingSummary(config: XaiChunkConfiguration | undefined): string {
  if (!config) return "";
  const strategies: Array<[keyof XaiChunkConfiguration, string, "tokens" | "chars" | "bytes"]> = [
    ["tokens_configuration", "Tokens", "tokens"],
    ["chars_configuration", "Characters", "chars"],
    ["markdown_tokens_configuration", "Markdown (tokens)", "tokens"],
    ["markdown_chars_configuration", "Markdown (characters)", "chars"],
    ["code_tokens_configuration", "Code (tokens)", "tokens"],
    ["code_chars_configuration", "Code (characters)", "chars"],
    ["table_configuration", "Tables (tokens)", "tokens"],
    ["bytes_configuration", "Bytes", "bytes"],
  ];
  for (const [key, label, unit] of strategies) {
    const block = config[key] as ChunkSize | undefined;
    if (!block) continue;
    const size =
      unit === "tokens"
        ? block.max_chunk_size_tokens
        : unit === "chars"
          ? block.max_chunk_size_chars
          : block.max_chunk_size_bytes;
    const overlap =
      unit === "tokens"
        ? block.chunk_overlap_tokens
        : unit === "chars"
          ? block.chunk_overlap_chars
          : block.chunk_overlap_bytes;
    const parts = [label];
    if (size) parts.push(`${size} ${unit} per chunk`);
    if (overlap) parts.push(`${overlap} overlap`);
    if (block.encoding_name) parts.push(block.encoding_name);
    return parts.join(" · ");
  }
  return "";
}

export function mapCollection(accountId: string, now: string, c: XaiCollection): ResourceInstance {
  const fields = c.field_definitions ?? [];
  return {
    id: `${accountId}:collection:${c.collection_id}`,
    pluginId: "xai",
    resourceTypeId: "collection",
    accountId,
    displayName: c.collection_name || c.collection_id,
    externalId: c.collection_id,
    fields: {
      collectionId: c.collection_id,
      name: c.collection_name ?? "",
      description: c.collection_description ?? "",
      embeddingModel: c.index_configuration?.model_name ?? "",
      chunking: chunkingSummary(c.chunk_configuration),
      collectionType: c.collection_type ?? "",
      documentsCount: c.documents_count ?? 0,
      fieldDefinitions: fields.map((d) => d.key).join(", "),
      createdAt: c.created_at ?? "",
    },
    resolvedOutputs: {
      collectionId: c.collection_id,
      name: c.collection_name ?? "",
      __fieldDefinitions__: JSON.stringify(fields),
      __chunking__: JSON.stringify(c.chunk_configuration ?? {}),
    },
    secretStates: [],
    createdAt: c.created_at || now,
    updatedAt: now,
  };
}

export function mapCollectionDocument(
  accountId: string,
  now: string,
  collection: { id: string; name: string },
  doc: XaiCollectionDocument,
): ResourceInstance | undefined {
  const meta = doc.file_metadata ?? {};
  const fileId = meta.file_id ?? "";
  if (!fileId) return undefined;
  const externalId = `${collection.id}/${fileId}`;
  return {
    id: `${accountId}:collection-document:${externalId}`,
    pluginId: "xai",
    resourceTypeId: "collection-document",
    accountId,
    displayName: meta.name || fileId,
    externalId,
    fields: {
      collectionId: collection.id,
      collectionName: collection.name,
      fileId,
      name: meta.name ?? "",
      status: doc.status ?? "",
      processingStatus: meta.processing_status ?? "",
      errorMessage: doc.error_message || meta.upload_error_message || "",
      sizeBytes: Number(meta.size_bytes ?? 0) || 0,
      contentType: meta.content_type ?? "",
      filePath: meta.file_path ?? "",
      metadata: Object.entries(doc.fields ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
      createdAt: meta.created_at ?? "",
      lastIndexedAt: doc.last_indexed_at ?? "",
    },
    resolvedOutputs: { fileId, collectionId: collection.id },
    secretStates: [],
    createdAt: meta.created_at || now,
    updatedAt: now,
  };
}

/** Split `{collection_id}/{file_id}`. */
export function splitDocumentId(externalId: string): { collectionId: string; fileId: string } {
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) {
    throw new Error(`xAI plugin: cannot parse collection document id "${externalId}"`);
  }
  return { collectionId: externalId.slice(0, slash), fileId: externalId.slice(slash + 1) };
}

export function documentStatusDot(
  status: string,
): "healthy" | "provisioning" | "error" | "unknown" {
  switch (status) {
    case "DOCUMENT_STATUS_PROCESSED":
      return "healthy";
    case "DOCUMENT_STATUS_PROCESSING":
      return "provisioning";
    case "DOCUMENT_STATUS_FAILED":
      return "error";
    default:
      return "unknown";
  }
}

export function documentStatusLabel(status: string): string {
  return status.replace(/^DOCUMENT_STATUS_/, "").toLowerCase() || "unknown";
}

export function renderCollectionDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  let definitions: XaiFieldDefinition[] = [];
  try {
    const parsed = JSON.parse(resource.resolvedOutputs["__fieldDefinitions__"] ?? "[]") as unknown;
    if (Array.isArray(parsed)) definitions = parsed as XaiFieldDefinition[];
  } catch {
    definitions = [];
  }

  const items: KVItem[] = [
    { key: "Collection ID", value: String(f["collectionId"] || DASH), copyable: true },
    { key: "Name", value: String(f["name"] || DASH) },
    { key: "Description", value: String(f["description"] || DASH) },
    { key: "Embedding Model", value: String(f["embeddingModel"] || DASH) },
    { key: "Chunking", value: String(f["chunking"] || "xAI default") },
    ...(f["collectionType"] ? [{ key: "Type", value: String(f["collectionType"]) }] : []),
    { key: "Documents", value: Number(f["documentsCount"] ?? 0).toLocaleString("en-US") },
    { key: "Created", value: String(f["createdAt"] || DASH) },
  ];

  return {
    title: resource.displayName,
    subtitle: "xAI Collection",
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      { kind: "section", title: "Collection", children: [{ kind: "key-value-list", items }] },
      {
        kind: "section",
        title: "Metadata Fields",
        children: [
          definitions.length > 0
            ? {
                kind: "table",
                emphasizeFirstColumn: true,
                columns: [
                  { key: "key", label: "Field", mono: true },
                  { key: "required", label: "Required" },
                  { key: "unique", label: "Unique" },
                  { key: "inject", label: "Injected Into Chunks" },
                  { key: "description", label: "Description" },
                ],
                rows: definitions.map((d) => ({
                  cells: {
                    key: d.key,
                    required: d.required ? "Yes" : "No",
                    unique: d.unique ? "Yes" : "No",
                    inject: d.inject_into_chunk ? "Yes" : "No",
                    description: d.description || DASH,
                  },
                })),
              }
            : {
                kind: "text",
                variant: "muted",
                content: "No metadata fields are defined for documents in this collection.",
              },
        ],
      },
      {
        kind: "section",
        title: "Documents",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              "Each indexed file is listed under Collection Documents, with its processing status. Attach an uploaded file from there; re-index or remove one from its page. The embedding model and chunking are fixed once the collection exists.",
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderCollectionDocumentDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const status = String(f["status"] ?? "");
  const size = Number(f["sizeBytes"] ?? 0);
  const error = String(f["errorMessage"] ?? "");

  return {
    title: resource.displayName,
    subtitle: `xAI Collection Document · ${String(f["collectionName"] || f["collectionId"] || "")}`,
    status: {
      kind: "status-dot",
      status: documentStatusDot(status),
      label: documentStatusLabel(status),
    },
    sections: [
      {
        kind: "section",
        title: "Document",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "File ID", value: String(f["fileId"] || DASH), copyable: true },
              { key: "Name", value: String(f["name"] || DASH) },
              {
                key: "Collection",
                value: String(f["collectionName"] || f["collectionId"] || DASH),
              },
              { key: "Status", value: documentStatusLabel(status) },
              { key: "Processing", value: String(f["processingStatus"] || DASH) },
              { key: "Size", value: size > 0 ? `${size.toLocaleString("en-US")} bytes` : DASH },
              { key: "Content Type", value: String(f["contentType"] || DASH) },
              { key: "Path", value: String(f["filePath"] || DASH) },
              { key: "Metadata", value: String(f["metadata"] || DASH) },
              { key: "Created", value: String(f["createdAt"] || DASH) },
              { key: "Last Indexed", value: String(f["lastIndexedAt"] || "not yet") },
            ],
          },
          ...(error ? [{ kind: "text" as const, variant: "body" as const, content: error }] : []),
        ],
      },
    ],
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: "Re-index",
        action: {
          type: "plugin-action",
          actionId: "reindex",
          confirmMessage:
            "Regenerate this document's index? Search results may be incomplete until it finishes.",
          successMessage: "Re-indexing started.",
        },
      },
    ],
  };
}
