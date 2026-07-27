import type { ResourceInstance } from "@infrawrench/plugin-base";
import { decodePromptArgs } from "@infrawrench/plugin-base";

/**
 * Action handlers for DigitalOcean's two action endpoints:
 *  - POST /v2/droplets/{id}/actions
 *  - POST /v2/volumes/{id}/actions
 *
 * Parameterless actions go through `invokeDropletAction` / `invokeVolumeAction`
 * — the host calls them from a `plugin-action` host action with a confirmation
 * dialog. Parameterised actions (snapshot name, resize size, rebuild image…)
 * arrive via `executeNoSqlCommand`, dispatched from `prompt-nosql-command` actions
 * whose modal collects the user's input first.
 *
 * The host wraps the prompt-modal form values as `args = [JSON.stringify(record)]`
 * (see desktop/web `onSubmitPromptModal`), so we parse `args[0]` once here.
 */

export interface ActionContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}

/** Strip `{accountId}:{typeId}:` off a resource id to get the DO external id. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/**
 * Wait for a DigitalOcean action to leave the "in-progress" state. POSTing to
 * `/v2/{resource}/{id}/actions` returns a queued action — GET `/v2/droplets`
 * (or `/v2/volumes`) right after may still report stale data, which is what
 * causes "I renamed it but the UI didn't update until I refreshed". For
 * actions whose effect is observable on the next list call (rename, resize,
 * rebuild, restore, change_backup_policy), block until the action reports
 * "completed" so the host's post-action refresh sees the new state.
 *
 * Bounded — caps at ~12s for actions whose API call already returned 201.
 * Snapshots and disk resizes can take minutes; for those we still resolve
 * after the cap so the UI unblocks, and the periodic 30s background refresh
 * eventually catches up.
 */
async function awaitAction(
  ctx: ActionContext,
  postResponse: unknown,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const action = (postResponse as { action?: { id?: number; status?: string } } | undefined)
    ?.action;
  if (!action?.id) return;
  if (action.status && action.status !== "in-progress") return;
  const maxAttempts = opts.maxAttempts ?? 12;
  const intervalMs = opts.intervalMs ?? 1000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const polled = await ctx.fetch<{ action: { status: string } }>(`/actions/${action.id}`);
      const status = polled.action.status;
      if (status === "completed") return;
      if (status === "errored") throw new Error("DigitalOcean reported the action as errored");
    } catch (err) {
      // Only re-throw the explicit errored case above. Network blips during
      // polling shouldn't fail the whole user action — fall through to next
      // attempt and let the periodic background refresh catch up later.
      if (err instanceof Error && err.message.includes("errored")) throw err;
    }
  }
}

/**
 * Poll GET /v2/droplets/{id} until a derived predicate is satisfied (e.g.
 * `next_backup_window` is non-null after enable_backups). DO's action-poll
 * endpoint can report "completed" before the droplet object itself reflects
 * the change — the action-level wait isn't enough on its own for state-flip
 * actions like enable_backups / disable_backups / enable_ipv6, where the
 * button label depends on a field that updates separately from the action.
 *
 * Caps at ~8 attempts × 1s = 8s. Tolerant of transient errors and stops as
 * soon as the predicate matches; falls through silently on timeout so the
 * UI still unblocks.
 */
async function awaitDropletState(
  ctx: ActionContext,
  dropletId: string,
  predicate: (droplet: Record<string, unknown>) => boolean,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const intervalMs = opts.intervalMs ?? 1000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const data = await ctx.fetch<{ droplet: Record<string, unknown> }>(`/droplets/${dropletId}`);
      if (predicate(data.droplet)) return;
    } catch {
      // Tolerate transient errors — drop through to the next tick.
    }
  }
}

/**
 * Parameterless droplet actions. The host pre-confirms destructive actions via
 * the schema's `confirmMessage`. Snapshot uses an auto-generated `{name}-{ISO}`
 * label so it can be fired without prompting the user.
 */
export async function invokeDropletAction(
  ctx: ActionContext,
  resourceId: string,
  accountId: string,
  actionId: string,
): Promise<void> {
  const id = externalIdOf(resourceId);

  if (actionId === "snapshot") {
    const droplet = await ctx.getResource("droplet", resourceId, accountId);
    const base = String(droplet.fields["name"] ?? `droplet-${id}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Snapshots are slow (minutes); don't block the UI on completion.
    await ctx.fetch(`/droplets/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ type: "snapshot", name: `${base}-${stamp}` }),
    });
    return;
  }

  const allowed = new Set([
    "power_on",
    "power_off",
    "power_cycle",
    "shutdown",
    "reboot",
    "enable_backups",
    "disable_backups",
    "enable_ipv6",
    "password_reset",
  ]);
  if (!allowed.has(actionId)) {
    throw new Error(`DigitalOcean plugin: unsupported droplet action "${actionId}"`);
  }
  const resp = await ctx.fetch<unknown>(`/droplets/${id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: actionId }),
  });
  // Lifecycle actions that flip droplet `status` (power_on/off/cycle, shutdown,
  // reboot) need to settle before the post-action listResources reflects the
  // new state — otherwise the status dot stays stale. Backup/IPv6 toggles and
  // password reset also benefit. Capped polling; long-runners fall through
  // to the periodic refresh.
  await awaitAction(ctx, resp);

  // State-flip actions: DO's action-poll endpoint can report "completed"
  // before the droplet object itself reflects the change, leaving the
  // Enable/Disable button stuck on its previous label. Wait for the
  // specific field that drives the button conditional in the renderer to
  // catch up. Falls through silently on timeout — the periodic refresh
  // covers the worst case.
  if (actionId === "enable_backups") {
    await awaitDropletState(ctx, id, (d) => {
      const features = Array.isArray(d["features"]) ? (d["features"] as string[]) : [];
      return features.includes("backups") || d["next_backup_window"] != null;
    });
  } else if (actionId === "disable_backups") {
    await awaitDropletState(ctx, id, (d) => {
      const features = Array.isArray(d["features"]) ? (d["features"] as string[]) : [];
      return !features.includes("backups") && d["next_backup_window"] == null;
    });
  } else if (actionId === "enable_ipv6") {
    await awaitDropletState(ctx, id, (d) => {
      const features = Array.isArray(d["features"]) ? (d["features"] as string[]) : [];
      const v6 = ((d["networks"] as Record<string, unknown> | undefined)?.["v6"] ?? []) as Array<{
        ip_address?: string;
      }>;
      return features.includes("ipv6") || v6.some((n) => !!n.ip_address);
    });
  }
}

/**
 * Parameterised droplet commands dispatched via `executeNoSqlCommand`. The
 * host's `prompt-nosql-command` modal posts the form values as a single
 * JSON-encoded arg (see `decodePromptArgs`). We use a single switch keyed off
 * `command`.
 */
export async function executeDropletCommand(
  ctx: ActionContext,
  resourceId: string,
  _accountId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = externalIdOf(resourceId);
  const values = decodePromptArgs(args);
  switch (command) {
    case "rename": {
      const name = (values["name"] ?? "").trim();
      if (!name) throw new Error("New name is required");
      const resp = await ctx.fetch<unknown>(`/droplets/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "rename", name }),
      });
      await awaitAction(ctx, resp);
      return null;
    }
    case "snapshot-named": {
      const name = (values["name"] ?? "").trim();
      if (!name) throw new Error("Snapshot name is required");
      // Snapshots can take minutes — fire and forget. The next periodic
      // refresh (or the user's manual refresh) will pick up the new
      // snapshot id once DO has finished imaging the disk.
      await ctx.fetch(`/droplets/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "snapshot", name }),
      });
      return null;
    }
    case "resize": {
      const size = (values["size"] ?? "").trim();
      const disk = (values["disk"] ?? "false") === "true";
      if (!size) throw new Error("New size slug is required");
      const resp = await ctx.fetch<unknown>(`/droplets/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "resize", size, disk }),
      });
      // CPU/RAM-only resize finishes within seconds; disk resizes can be
      // multi-minute. We block only briefly so the modal doesn't hang on
      // long disk grows — the background refresh covers the slow case.
      await awaitAction(ctx, resp, { maxAttempts: disk ? 6 : 12 });
      return null;
    }
    case "rebuild": {
      const image = (values["image"] ?? "").trim();
      if (!image) throw new Error("Image slug or id is required");
      const imagePayload = /^\d+$/.test(image) ? Number(image) : image;
      const resp = await ctx.fetch<unknown>(`/droplets/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "rebuild", image: imagePayload }),
      });
      // Rebuilds run multi-minute. Don't block — let background refresh handle it.
      void resp;
      return null;
    }
    case "restore": {
      const imageId = Number(values["image"]);
      if (!Number.isFinite(imageId)) throw new Error("Backup or snapshot id is required");
      await ctx.fetch(`/droplets/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "restore", image: imageId }),
      });
      return null;
    }
    case "change-backup-policy": {
      const plan = String(values["plan"] ?? "daily");
      const hour = Number(values["hour"] ?? 4);
      const weekday = String(values["weekday"] ?? "SUN");
      const policy: Record<string, unknown> = { plan, hour };
      if (plan === "weekly") policy["weekday"] = weekday;
      const resp = await ctx.fetch<unknown>(`/droplets/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "change_backup_policy", backup_policy: policy }),
      });
      await awaitAction(ctx, resp);
      return null;
    }
    default:
      throw new Error(`DigitalOcean plugin: unknown droplet command "${command}"`);
  }
}

/**
 * Parameterless volume action: detach from whichever droplet currently holds
 * the volume. Resize and snapshot are parameterised; see `executeVolumeCommand`.
 */
export async function invokeVolumeAction(
  ctx: ActionContext,
  resourceId: string,
  accountId: string,
  actionId: string,
): Promise<void> {
  const id = externalIdOf(resourceId);
  if (actionId === "detach") {
    const volume = await ctx.getResource("volume", resourceId, accountId);
    const region = String(volume.fields["region"] ?? "");
    const dropletIds = String(volume.fields["dropletIds"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (dropletIds.length === 0) {
      throw new Error("Volume is not attached to any droplet");
    }
    for (const dropletId of dropletIds) {
      const resp = await ctx.fetch<unknown>(`/volumes/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "detach", droplet_id: Number(dropletId), region }),
      });
      await awaitAction(ctx, resp);
    }
    return;
  }
  throw new Error(`DigitalOcean plugin: unsupported volume action "${actionId}"`);
}

export async function executeVolumeCommand(
  ctx: ActionContext,
  resourceId: string,
  accountId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  const id = externalIdOf(resourceId);
  const values = decodePromptArgs(args);
  switch (command) {
    case "volume-resize": {
      const newSize = Number(values["sizeGb"]);
      if (!Number.isFinite(newSize) || newSize <= 0) {
        throw new Error("New size in GiB is required");
      }
      const volume = await ctx.getResource("volume", resourceId, accountId);
      const region = String(volume.fields["region"] ?? "");
      const resp = await ctx.fetch<unknown>(`/volumes/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "resize", size_gigabytes: newSize, region }),
      });
      await awaitAction(ctx, resp);
      return null;
    }
    case "volume-snapshot": {
      const name = (values["name"] ?? "").trim();
      if (!name) throw new Error("Snapshot name is required");
      await ctx.fetch(`/volumes/${id}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      return null;
    }
    default:
      throw new Error(`DigitalOcean plugin: unknown volume command "${command}"`);
  }
}
