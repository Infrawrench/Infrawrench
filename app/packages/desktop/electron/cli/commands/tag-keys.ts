// `infrawrench tag-keys`: the tag keys the org's cost data and inventory
// carry, with which ones the org hides from its pickers and which it pins to
// the top; plus `hide`/`unhide`/`pin`/`unpin` to edit those lists.
//
// Writes are allowed here, unlike `billing-rules`: hiding a key changes what a
// picker offers and nothing else, no figure moves, and the server still
// audit-logs every save. The wire shapes come from `@infrawrench/client-core`
// type-only, so the CLI keeps its zero-runtime-dependency rule; pattern
// validation is the server's (it answers a 400 naming the problem).
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  DiscoveredTagKey,
  DiscoveredTagKeysResponse,
  TagKeySettings,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable } from "../output";

export type TagKeysAction = "list" | "hide" | "unhide" | "pin" | "unpin";

export const TAG_KEYS_ACTIONS: readonly TagKeysAction[] = ["hide", "unhide", "pin", "unpin"];

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Tag key settings are org-level cloud state; there is nothing local to list.",
    );
  }
}

/** One row's status, in words. */
function statusText(k: DiscoveredTagKey): string {
  if (k.preferred) return c.cyan("preferred");
  if (k.hidden) {
    return k.hiddenBy && k.hiddenBy !== k.key ? c.dim(`hidden by ${k.hiddenBy}`) : c.dim("hidden");
  }
  return "visible";
}

/** `infrawrench tag-keys`: discovered keys with usage and status. */
export async function cmdTagKeys(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const res = await orgFetch<DiscoveredTagKeysResponse>(org.id, "/tag-keys");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...res });
    return;
  }

  const { settings } = res;
  println(
    `${c.bold(org.displayName)} ${c.dim("· preferred")} ${
      settings.preferred.length ? c.bold(settings.preferred.join(", ")) : c.dim("none")
    } ${c.dim("· hidden")} ${settings.hidden.length ? settings.hidden.join(", ") : c.dim("none")}`,
  );
  println();
  printTable(res.keys, [
    {
      header: "key",
      value: (k) => (k.hidden ? c.dim(k.key) : k.preferred ? c.bold(k.key) : k.key),
    },
    { header: "providers", value: (k) => k.providers.join(",") || c.dim("—") },
    { header: "cost rows", value: (k) => k.costRowCount.toLocaleString("en-US"), align: "right" },
    {
      header: "resources",
      value: (k) => Math.max(k.costResourceCount, k.inventoryCount).toLocaleString("en-US"),
      align: "right",
    },
    { header: "last seen", value: (k) => k.lastSeen ?? c.dim("—") },
    { header: "status", value: statusText },
  ]);
  println();
  println(
    c.dim(
      `Cost usage covers the last ${res.lookbackDays} days.` +
        (res.truncated ? ` Showing the ${res.keys.length} busiest keys.` : "") +
        " Hidden keys are only left out of pickers; their data is still queryable.",
    ),
  );
}

/** Apply one edit to the settings document. Pure, exported for tests. */
export function editTagKeySettings(
  settings: TagKeySettings,
  action: Exclude<TagKeysAction, "list">,
  value: string,
): TagKeySettings {
  const v = value.trim();
  switch (action) {
    case "hide":
      return {
        hidden: settings.hidden.includes(v) ? settings.hidden : [...settings.hidden, v],
        preferred: settings.preferred.filter((p) => p !== v),
      };
    case "unhide":
      return { ...settings, hidden: settings.hidden.filter((h) => h !== v) };
    case "pin":
      return {
        hidden: settings.hidden.filter((h) => h !== v),
        preferred: settings.preferred.includes(v) ? settings.preferred : [...settings.preferred, v],
      };
    case "unpin":
      return { ...settings, preferred: settings.preferred.filter((p) => p !== v) };
  }
}

/** `infrawrench tag-keys hide|unhide|pin|unpin <key-or-pattern>`. */
export async function cmdEditTagKeys(
  ctx: CliContext,
  action: Exclude<TagKeysAction, "list">,
  value: string,
): Promise<void> {
  requireCloud(ctx);
  if (!value.trim()) {
    throw new CliError(
      action === "hide" || action === "unhide"
        ? `Usage: infrawrench tag-keys ${action} <key | prefix*>   e.g. 'aws:cloudformation:*'`
        : `Usage: infrawrench tag-keys ${action} <key>`,
    );
  }
  const org = await resolveOrg(ctx);
  const current = await orgFetch<TagKeySettings>(org.id, "/tag-keys/settings");
  const next = editTagKeySettings(current, action, value);
  const unchanged =
    next.hidden.length === current.hidden.length &&
    next.preferred.length === current.preferred.length &&
    next.hidden.every((h, i) => h === current.hidden[i]) &&
    next.preferred.every((p, i) => p === current.preferred[i]);

  const saved = unchanged
    ? current
    : await orgFetch<TagKeySettings>(org.id, "/tag-keys/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, changed: !unchanged, settings: saved });
    return;
  }
  if (unchanged) {
    println(
      c.dim(
        `Nothing to change: ${value.trim()} was already ${action === "hide" ? "hidden" : action === "pin" ? "pinned" : `not ${action === "unhide" ? "hidden" : "pinned"}`}.`,
      ),
    );
  }
  println(
    `${c.dim("preferred")} ${saved.preferred.length ? saved.preferred.join(", ") : c.dim("none")}`,
  );
  println(`${c.dim("hidden   ")} ${saved.hidden.length ? saved.hidden.join(", ") : c.dim("none")}`);
}
