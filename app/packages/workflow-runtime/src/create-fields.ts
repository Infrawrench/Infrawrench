/**
 * Distills a plugin's rich `CreateResourceConfig` (returned by
 * `PluginClient.getCreateConfig`) down to the small {@link WorkflowCreateFieldInfo}
 * shape that codegen needs to type `create({...})` with real field keys and
 * enumerable option values — instead of a generic `Record<string, string>`.
 *
 * Shared here (rather than per-platform) so the web server, the poller, and the
 * Electron main process all map create fields identically.
 */
import type { CreateFieldConfig, CreateResourceConfig } from "@infrawrench/plugin-base";

import type { WorkflowCreateFieldInfo } from "./types.js";

/** Upper bound on emitted option literals per field, to keep `infra.d.ts` small. */
const MAX_OPTIONS = 200;

/**
 * The enumerable option ids for a field, when its kind carries a closed list.
 * Free-form kinds (text/number/password/hostname/datetime/code/…) and dynamic
 * pickers (ssh-key-picker, resource-picker — values are user/account specific)
 * return undefined, so codegen leaves them as an open `string`.
 */
function optionsFor(field: CreateFieldConfig): string[] | undefined {
  let ids: string[] | undefined;
  switch (field.kind) {
    case "select":
      ids = field.options?.map((o) => o.id);
      break;
    case "region-picker":
      ids = field.regions?.map((r) => r.id);
      break;
    case "size-picker":
      ids = field.sizes?.map((s) => s.id);
      break;
    case "image-picker":
      ids = field.images?.map((i) => i.id);
      break;
    case "disk-picker":
      ids = field.disks?.map((d) => d.id);
      break;
    case "policy-picker":
      ids = field.policies?.map((p) => p.id);
      break;
    default:
      ids = undefined;
  }
  if (!ids || ids.length === 0) return undefined;
  // De-dupe and cap so a provider with hundreds of sizes can't bloat the d.ts.
  return Array.from(new Set(ids)).slice(0, MAX_OPTIONS);
}

/** Map a plugin's create config to the codegen-facing field descriptors. */
export function createFieldsFromConfig(config: CreateResourceConfig): WorkflowCreateFieldInfo[] {
  const out: WorkflowCreateFieldInfo[] = [];
  for (const field of config.fields ?? []) {
    // Transient fields are UI-only toggles the host strips before create.
    if (field.transient) continue;
    const info: WorkflowCreateFieldInfo = {
      key: field.key,
      kind: field.kind,
      required: Boolean(field.required),
    };
    const options = optionsFor(field);
    if (options) info.options = options;
    if (field.description) info.description = field.description;
    out.push(info);
  }
  return out;
}
