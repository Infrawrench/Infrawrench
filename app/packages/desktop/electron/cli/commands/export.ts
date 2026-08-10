// `infrawrench export --format terraform` — eject an account's inventory as
// Terraform HCL. Mapping runs from the same stored/enumerated state the
// `resources` command shows, through each plugin's declared terraformExport
// capability and the shared plugin-base HCL serializer — identical output to
// the web app's "Export to Terraform" action.
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { getPlugin } from "../../../src/plugins/loader";
import {
  CliError,
  listCloudResources,
  listLocalResources,
  type CliContext,
  type ResourceRow,
} from "../context";
import { resolveScopedAccount } from "./listing";
import { c, printErr, printJson, println } from "../output";

function toResourceInstance(row: ResourceRow): ResourceInstance {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(row.fields)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  const outputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.outputs)) {
    if (typeof value === "string") outputs[key] = value;
  }
  return {
    id: row.id,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    accountId: row.accountId,
    displayName: row.displayName,
    fields,
    resolvedOutputs: outputs,
    secretStates: [],
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.parentResourceId ? { parentResourceId: row.parentResourceId } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

export async function cmdExport(ctx: CliContext, format: string | undefined): Promise<void> {
  const chosen = format ?? "terraform";
  if (chosen !== "terraform") {
    throw new CliError(`Unknown export format "${chosen}" — only "terraform" is supported.`, 2);
  }
  const { orgId, account } = await resolveScopedAccount(ctx);

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new CliError(`Plugin "${account.pluginId}" is not available.`);
  const capability = loaded.plugin.terraformExport;
  if (!capability) {
    throw new CliError(
      `The ${account.pluginId} plugin has no Terraform mapping yet — nothing to export.`,
    );
  }

  let rows: ResourceRow[];
  if (orgId) {
    rows = await listCloudResources(orgId, account.id);
  } else {
    const listing = await listLocalResources(account, {});
    // Types the provider refused would silently vanish from the export —
    // report them on stderr so `--json`/redirected stdout stay clean.
    for (const e of listing.errors) printErr(c.yellow(`${e.typeId}: ${e.message}`));
    rows = listing.rows;
  }

  // Top-level resources lead the file; children follow.
  const ordered = [...rows].sort(
    (a, b) =>
      (a.parentResourceId ? 1 : 0) - (b.parentResourceId ? 1 : 0) || a.id.localeCompare(b.id),
  );
  const outcome = exportResourcesToTerraform(ordered.map(toResourceInstance), (pluginId) =>
    pluginId === account.pluginId ? capability : undefined,
  );

  if (ctx.flags.output === "json") {
    printJson(outcome);
    return;
  }

  // Unsupported resources go to stderr so `> main.tf` captures pure HCL.
  if (outcome.unsupported.length > 0) {
    printErr(
      c.yellow(
        `${outcome.unsupported.length} resource(s) have no Terraform mapping yet and were left out:`,
      ),
    );
    for (const u of outcome.unsupported) {
      printErr(c.yellow(`  - ${u.displayName} (${u.resourceTypeId}): ${u.reason}`));
    }
  }
  if (!outcome.hcl) {
    printErr(c.yellow("Nothing to export — no resource in this account has a Terraform mapping."));
    return;
  }
  printErr(
    c.dim(
      `${outcome.exported.length} resource(s) exported. Secrets are var.* inputs; ` +
        "see the `terraform import` hints to adopt live resources into state.",
    ),
  );
  println(outcome.hcl.trimEnd());
}
