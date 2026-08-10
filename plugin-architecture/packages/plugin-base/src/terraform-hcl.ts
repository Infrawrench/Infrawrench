import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
  TerraformVariable,
} from "./terraform.js";

/**
 * Generic HCL serializer for the Terraform export capability. Host-side and
 * provider-agnostic: plugins return structured {@link TerraformExportResult}
 * data and this module turns any number of them (possibly spanning several
 * plugins) into one `main.tf`-style document. Zero runtime dependencies.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Sanitize an arbitrary display name into a valid Terraform local name. */
export function sanitizeTerraformName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (cleaned === "") return "resource";
  return /^[0-9]/.test(cleaned) ? `r_${cleaned}` : cleaned;
}

function escapeHclString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\$\{/g, () => "$${")
    .replace(/%\{/g, () => "%%{");
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

/** Serialize a single {@link TerraformValue} as an HCL expression. */
export function renderTerraformValue(value: TerraformValue, indent = ""): string {
  switch (value.kind) {
    case "string":
      return `"${escapeHclString(value.value)}"`;
    case "number":
      return formatNumber(value.value);
    case "bool":
      return value.value ? "true" : "false";
    case "ref":
      return value.expr;
    case "list": {
      if (value.items.length === 0) return "[]";
      const items = value.items.map((item) => renderTerraformValue(item, indent));
      return `[${items.join(", ")}]`;
    }
    case "map": {
      const entries = Object.entries(value.entries);
      if (entries.length === 0) return "{}";
      const inner = indent + "  ";
      const lines = entries.map(([key, entry]) => {
        const safeKey = IDENT_RE.test(key) ? key : `"${escapeHclString(key)}"`;
        return `${inner}${safeKey} = ${renderTerraformValue(entry, inner)}`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
  }
}

function renderAttributes(attributes: Record<string, TerraformValue>, indent: string): string[] {
  const entries = Object.entries(attributes);
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries.map(
    ([key, value]) => `${indent}${key.padEnd(width)} = ${renderTerraformValue(value, indent)}`,
  );
}

/** Everything the serializer needs from one plugin's export. */
export interface TerraformProviderSection {
  capability: TerraformExportCapability;
  results: TerraformExportResult[];
}

export interface RenderedTerraformResource {
  /** Terraform resource type, e.g. "hcloud_server". */
  type: string;
  /** Final (deduplicated) local name. */
  name: string;
  /** Terraform address, e.g. `hcloud_server.web_1`. */
  address: string;
  /** Import ID when the plugin supplied one. */
  importId?: string | undefined;
}

export interface RenderedTerraformBundle {
  /** The complete HCL document. */
  hcl: string;
  /** One entry per rendered resource block, in document order. */
  resources: RenderedTerraformResource[];
}

/**
 * Render one or more provider sections into a single HCL document:
 * a `terraform.required_providers` block, `variable` blocks (deduplicated by
 * name), one `provider` block per section, then every resource block with
 * its import hint as a leading comment.
 */
export function renderTerraformBundle(
  sections: TerraformProviderSection[],
): RenderedTerraformBundle {
  const active = sections.filter((s) => s.results.length > 0);
  const rendered: RenderedTerraformResource[] = [];
  if (active.length === 0) return { hcl: "", resources: rendered };

  const parts: string[] = [];

  // terraform { required_providers { ... } }
  const providerLines = active.map((s) => {
    const p = s.capability.provider;
    return `    ${p.name} = {\n      source  = "${escapeHclString(p.source)}"\n      version = "${escapeHclString(p.version)}"\n    }`;
  });
  parts.push(`terraform {\n  required_providers {\n${providerLines.join("\n")}\n  }\n}`);

  // variable blocks — provider-level plus per-result extras, deduped by name.
  const variables = new Map<string, TerraformVariable>();
  for (const section of active) {
    for (const v of section.capability.variables) {
      if (!variables.has(v.name)) variables.set(v.name, v);
    }
    for (const result of section.results) {
      for (const v of result.variables ?? []) {
        if (!variables.has(v.name)) variables.set(v.name, v);
      }
    }
  }
  for (const v of variables.values()) {
    const lines = [`variable "${escapeHclString(v.name)}" {`, `  type = string`];
    if (v.description) lines.push(`  description = "${escapeHclString(v.description)}"`);
    if (v.sensitive) lines.push(`  sensitive = true`);
    lines.push("}");
    parts.push(lines.join("\n"));
  }

  // provider blocks
  for (const section of active) {
    const name = section.capability.provider.name;
    const attrs = renderAttributes(section.capability.providerConfig, "  ");
    parts.push(`provider "${escapeHclString(name)}" {\n${attrs.join("\n")}\n}`);
  }

  // resource blocks with name deduplication across the whole bundle
  const usedNames = new Set<string>();
  for (const section of active) {
    for (const result of section.results) {
      const block = result.resource;
      const base = sanitizeTerraformName(block.name);
      let localName = base;
      let n = 2;
      while (usedNames.has(`${block.type}.${localName}`)) {
        localName = `${base}_${n}`;
        n += 1;
      }
      usedNames.add(`${block.type}.${localName}`);
      const address = `${block.type}.${localName}`;

      const lines: string[] = [];
      for (const comment of block.comments ?? []) lines.push(`# ${comment}`);
      if (block.importId) {
        lines.push(`# To adopt the existing resource into Terraform state:`);
        lines.push(`#   terraform import ${address} ${block.importId}`);
      }
      lines.push(`resource "${escapeHclString(block.type)}" "${escapeHclString(localName)}" {`);
      lines.push(...renderAttributes(block.attributes, "  "));
      lines.push("}");
      parts.push(lines.join("\n"));

      rendered.push({ type: block.type, name: localName, address, importId: block.importId });
    }
  }

  return { hcl: parts.join("\n\n") + "\n", resources: rendered };
}
