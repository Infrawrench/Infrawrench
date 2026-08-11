import type { ResourceInstance } from "./instance.js";
import type { TerraformExportCapability, TerraformExportResult } from "./terraform.js";
import type { RenderedTerraformResource } from "./terraform-hcl.js";
import { renderTerraformBundle } from "./terraform-hcl.js";

/**
 * Host-side orchestration for "eject to Terraform": takes stored resources
 * (possibly spanning several plugins), asks each plugin's declared
 * {@link TerraformExportCapability} to map them, and renders one HCL document.
 * Shared by the web server and the desktop CLI so both produce identical
 * output. Pure and dependency-free — safe to run against persisted state.
 */

export interface TerraformExportedResource {
  /** The source resource (internal id). */
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  /** Terraform address, e.g. `hcloud_server.web_1`. */
  address: string;
  /** `terraform import` ID when known. */
  importId?: string;
}

export interface TerraformUnsupportedResource {
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  /** Why this resource was left out of the generated config. */
  reason: string;
}

export interface TerraformExportOutcome {
  /** The complete HCL document ("" when nothing mapped). */
  hcl: string;
  exported: TerraformExportedResource[];
  unsupported: TerraformUnsupportedResource[];
}

/** Read a string field off a stored resource, "" when absent. */
export function fieldString(resource: ResourceInstance, key: string): string {
  const v = resource.fields[key];
  if (v == null) return "";
  return String(v);
}

/** Read a numeric field off a stored resource, undefined when absent/NaN. */
export function fieldNumber(resource: ResourceInstance, key: string): number | undefined {
  const v = resource.fields[key];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a boolean field off a stored resource. */
export function fieldBool(resource: ResourceInstance, key: string): boolean {
  const v = resource.fields[key];
  return v === true || v === "true";
}

/**
 * Map + render a set of stored resources. `capabilityForPlugin` resolves the
 * plugin's `terraformExport` declaration (return undefined for plugins
 * without one — their resources land in `unsupported`).
 */
export function exportResourcesToTerraform(
  resourcesToExport: ResourceInstance[],
  capabilityForPlugin: (pluginId: string) => TerraformExportCapability | undefined,
): TerraformExportOutcome {
  const unsupported: TerraformUnsupportedResource[] = [];
  const sections = new Map<
    string,
    {
      capability: TerraformExportCapability;
      results: TerraformExportResult[];
      sources: ResourceInstance[];
    }
  >();

  for (const resource of resourcesToExport) {
    const base = {
      id: resource.id,
      displayName: resource.displayName,
      pluginId: resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
    };
    const capability = capabilityForPlugin(resource.pluginId);
    if (!capability) {
      unsupported.push({ ...base, reason: "Plugin has no Terraform mapping yet" });
      continue;
    }
    if (!capability.supportedResourceTypeIds.includes(resource.resourceTypeId)) {
      unsupported.push({ ...base, reason: "No Terraform mapping for this resource type yet" });
      continue;
    }
    let result: TerraformExportResult | null;
    try {
      result = capability.mapResource(resource);
    } catch (e) {
      unsupported.push({
        ...base,
        reason: e instanceof Error ? e.message : "Terraform mapping failed",
      });
      continue;
    }
    if (!result) {
      unsupported.push({
        ...base,
        reason: "Stored state is missing fields required by the Terraform provider",
      });
      continue;
    }
    let section = sections.get(resource.pluginId);
    if (!section) {
      section = { capability, results: [], sources: [] };
      sections.set(resource.pluginId, section);
    }
    section.results.push(result);
    section.sources.push(resource);
  }

  const ordered = Array.from(sections.values());
  const bundle = renderTerraformBundle(
    ordered.map((s) => ({ capability: s.capability, results: s.results })),
  );

  // renderTerraformBundle emits blocks section-by-section in input order, so
  // the rendered list zips 1:1 with the concatenated source lists.
  const flatSources: ResourceInstance[] = [];
  for (const s of ordered) flatSources.push(...s.sources);
  const exported: TerraformExportedResource[] = bundle.resources.map(
    (rendered: RenderedTerraformResource, i: number) => ({
      id: flatSources[i]?.id ?? "",
      displayName: flatSources[i]?.displayName ?? rendered.name,
      pluginId: flatSources[i]?.pluginId ?? "",
      resourceTypeId: flatSources[i]?.resourceTypeId ?? "",
      address: rendered.address,
      ...(rendered.importId ? { importId: rendered.importId } : {}),
    }),
  );

  return { hcl: bundle.hcl, exported, unsupported };
}

/**
 * Render Terraform 1.5+ `import` blocks for an export outcome.
 *
 * The export already prints `terraform import …` as a comment, which is the
 * right hint when someone is reading one resource. Adoption at scale wants the
 * declarative form: `import` blocks are planned, reviewed and applied with the
 * configuration itself, so a whole set of hand-made resources comes under
 * management in one `terraform apply` rather than N imperative commands.
 *
 * Only resources whose plugin supplied an `importId` can be adopted; the rest
 * are skipped (their stanza still renders, so the resource can be adopted once
 * an id is known).
 */
export function renderTerraformImportBlocks(
  exported: readonly TerraformExportedResource[],
): string {
  const blocks = exported
    .filter((entry) => entry.importId)
    .map(
      (entry) => `import {\n  to = ${entry.address}\n  id = ${JSON.stringify(entry.importId)}\n}`,
    );
  return blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
}

/**
 * One document that both declares the resources and adopts them: `import`
 * blocks first (so a reader sees what is about to be taken over), then the
 * generated configuration. This is the payoff surface of IaC reconciliation —
 * "here is the Terraform for the 40 things somebody made by hand".
 */
export function renderTerraformAdoptionDocument(outcome: TerraformExportOutcome): string {
  const imports = renderTerraformImportBlocks(outcome.exported);
  if (!imports) return outcome.hcl;
  if (!outcome.hcl) return imports;
  return `${imports}\n${outcome.hcl}`;
}
