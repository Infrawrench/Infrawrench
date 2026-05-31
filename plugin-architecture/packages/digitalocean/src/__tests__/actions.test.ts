import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import {
  type ActionContext,
  invokeDropletAction,
  invokeVolumeAction,
  executeDropletCommand,
  executeVolumeCommand,
} from "../actions.js";

function makeResource(fields: Record<string, string>): ResourceInstance {
  return {
    id: "acc:droplet:123",
    pluginId: "digitalocean",
    resourceTypeId: "droplet",
    accountId: "acc",
    displayName: "web-1",
    fields,
    resolvedOutputs: {},
    secretStates: [],
  } as unknown as ResourceInstance;
}

interface FakeCtx extends ActionContext {
  fetch: ReturnType<typeof vi.fn>;
  getResource: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx {
  const ctx: FakeCtx = {
    fetch: vi.fn().mockResolvedValue({}),
    getResource: vi.fn().mockResolvedValue(makeResource({ name: "web-1" })),
    ...overrides,
  } as FakeCtx;
  return ctx;
}

const encodeArgs = (rec: Record<string, string>): string[] => [JSON.stringify(rec)];

describe("invokeDropletAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("snapshot uses an auto-generated {name}-{ISO} label and does not poll", async () => {
    const ctx = makeCtx();
    await invokeDropletAction(ctx, "acc:droplet:123", "acc", "snapshot");
    expect(ctx.getResource).toHaveBeenCalledWith("droplet", "acc:droplet:123", "acc");
    const call = ctx.fetch.mock.calls[0]!;
    expect(call[0]).toBe("/droplets/123/actions");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.type).toBe("snapshot");
    expect(body.name).toMatch(/^web-1-\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an unsupported action id", async () => {
    const ctx = makeCtx();
    await expect(invokeDropletAction(ctx, "acc:droplet:123", "acc", "nuke")).rejects.toThrow(
      /unsupported droplet action "nuke"/,
    );
  });

  it("power_on posts the action and awaits a completed action", async () => {
    const ctx = makeCtx({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({ action: { id: 99, status: "in-progress" } })
        .mockResolvedValueOnce({ action: { status: "completed" } }),
    });
    const p = invokeDropletAction(ctx, "acc:droplet:123", "acc", "power_on");
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(ctx.fetch).toHaveBeenNthCalledWith(1, "/droplets/123/actions", expect.any(Object));
    expect(ctx.fetch).toHaveBeenNthCalledWith(2, "/actions/99");
  });

  it("enable_backups waits for the next_backup_window / features to settle", async () => {
    const ctx = makeCtx({
      fetch: vi
        .fn()
        // POST action
        .mockResolvedValueOnce({ action: { id: 5, status: "completed" } })
        // awaitDropletState GET — first not ready, then ready
        .mockResolvedValueOnce({ droplet: { features: [], next_backup_window: null } })
        .mockResolvedValueOnce({ droplet: { features: ["backups"] } }),
    });
    const p = invokeDropletAction(ctx, "acc:droplet:123", "acc", "enable_backups");
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    // 1 POST + 2 state polls
    expect(ctx.fetch).toHaveBeenCalledTimes(3);
  });

  it("disable_backups waits until backups feature is gone", async () => {
    const ctx = makeCtx({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({ action: { id: 6, status: "completed" } })
        .mockResolvedValueOnce({ droplet: { features: [], next_backup_window: null } }),
    });
    const p = invokeDropletAction(ctx, "acc:droplet:123", "acc", "disable_backups");
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
  });

  it("enable_ipv6 waits for an ipv6 address", async () => {
    const ctx = makeCtx({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({ action: { id: 7, status: "completed" } })
        .mockResolvedValueOnce({
          droplet: { features: ["ipv6"], networks: { v6: [{ ip_address: "::1" }] } },
        }),
    });
    const p = invokeDropletAction(ctx, "acc:droplet:123", "acc", "enable_ipv6");
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
  });

  it("awaitAction returns immediately when there is no action id", async () => {
    const ctx = makeCtx({ fetch: vi.fn().mockResolvedValueOnce({}) });
    await invokeDropletAction(ctx, "acc:droplet:123", "acc", "reboot");
    // only the POST, no poll
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it("awaitAction throws when the polled action is errored", async () => {
    const ctx = makeCtx({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({ action: { id: 8, status: "in-progress" } })
        .mockResolvedValueOnce({ action: { status: "errored" } }),
    });
    const p = invokeDropletAction(ctx, "acc:droplet:123", "acc", "power_off");
    const assertion = expect(p).rejects.toThrow(/errored/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("awaitAction tolerates transient poll errors and stops after maxAttempts", async () => {
    const ctx = makeCtx({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({ action: { id: 9, status: "in-progress" } })
        .mockRejectedValue(new Error("network blip")),
    });
    const p = invokeDropletAction(ctx, "acc:droplet:123", "acc", "shutdown");
    await vi.advanceTimersByTimeAsync(13000);
    await p;
    // 1 POST + 12 poll attempts
    expect(ctx.fetch).toHaveBeenCalledTimes(13);
  });
});

describe("executeDropletCommand", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rename requires a name", async () => {
    const ctx = makeCtx();
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "rename", encodeArgs({ name: "  " })),
    ).rejects.toThrow(/New name is required/);
  });

  it("rename posts and awaits", async () => {
    const ctx = makeCtx({
      fetch: vi.fn().mockResolvedValue({ action: { id: 1, status: "completed" } }),
    });
    const r = await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "rename",
      encodeArgs({ name: "new-name" }),
    );
    expect(r).toBeNull();
    const body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "rename", name: "new-name" });
  });

  it("snapshot-named requires a name and posts a snapshot", async () => {
    const ctx = makeCtx();
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "snapshot-named", encodeArgs({})),
    ).rejects.toThrow(/Snapshot name is required/);
    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "snapshot-named",
      encodeArgs({ name: "snap1" }),
    );
    const body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "snapshot", name: "snap1" });
  });

  it("resize requires a size and posts disk flag", async () => {
    const ctx = makeCtx({ fetch: vi.fn().mockResolvedValue({}) });
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "resize", encodeArgs({ size: "" })),
    ).rejects.toThrow(/New size slug is required/);
    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "resize",
      encodeArgs({ size: "s-2vcpu-4gb", disk: "true" }),
    );
    const body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "resize", size: "s-2vcpu-4gb", disk: true });
  });

  it("rebuild coerces a numeric image id and does not block", async () => {
    const ctx = makeCtx();
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "rebuild", encodeArgs({ image: "" })),
    ).rejects.toThrow(/Image slug or id is required/);
    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "rebuild",
      encodeArgs({ image: "12345" }),
    );
    let body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.image).toBe(12345);
    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "rebuild",
      encodeArgs({ image: "ubuntu-22-04-x64" }),
    );
    body = JSON.parse((ctx.fetch.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.image).toBe("ubuntu-22-04-x64");
  });

  it("restore requires a finite image id", async () => {
    const ctx = makeCtx();
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "restore", encodeArgs({ image: "abc" })),
    ).rejects.toThrow(/Backup or snapshot id is required/);
    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "restore",
      encodeArgs({ image: "777" }),
    );
    const body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "restore", image: 777 });
  });

  it("change-backup-policy includes weekday only for weekly plans", async () => {
    const ctx = makeCtx({ fetch: vi.fn().mockResolvedValue({}) });
    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "change-backup-policy",
      encodeArgs({ plan: "weekly", hour: "2", weekday: "MON" }),
    );
    let body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.backup_policy).toEqual({ plan: "weekly", hour: 2, weekday: "MON" });

    await executeDropletCommand(
      ctx,
      "acc:droplet:123",
      "acc",
      "change-backup-policy",
      encodeArgs({ plan: "daily" }),
    );
    body = JSON.parse((ctx.fetch.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.backup_policy).toEqual({ plan: "daily", hour: 4 });
  });

  it("rejects an unknown droplet command", async () => {
    const ctx = makeCtx();
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "frobnicate", encodeArgs({})),
    ).rejects.toThrow(/unknown droplet command "frobnicate"/);
  });

  it("decodePromptArgs tolerates a non-string / non-JSON first arg", async () => {
    const ctx = makeCtx();
    // numeric first arg → empty values → name missing
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "rename", [42]),
    ).rejects.toThrow(/New name is required/);
    await expect(
      executeDropletCommand(ctx, "acc:droplet:123", "acc", "rename", ["{not json"]),
    ).rejects.toThrow(/New name is required/);
  });
});

describe("invokeVolumeAction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("detach posts a detach action for every attached droplet", async () => {
    const ctx = makeCtx({
      getResource: vi
        .fn()
        .mockResolvedValue(makeResource({ region: "nyc3", dropletIds: "111, 222" })),
      fetch: vi.fn().mockResolvedValue({ action: { id: 1, status: "completed" } }),
    });
    await invokeVolumeAction(ctx, "acc:volume:vol-1", "acc", "detach");
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
    const b0 = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(b0).toEqual({ type: "detach", droplet_id: 111, region: "nyc3" });
  });

  it("detach throws when the volume is not attached", async () => {
    const ctx = makeCtx({
      getResource: vi.fn().mockResolvedValue(makeResource({ region: "nyc3", dropletIds: "" })),
    });
    await expect(invokeVolumeAction(ctx, "acc:volume:vol-1", "acc", "detach")).rejects.toThrow(
      /not attached to any droplet/,
    );
  });

  it("rejects an unsupported volume action", async () => {
    const ctx = makeCtx();
    await expect(invokeVolumeAction(ctx, "acc:volume:vol-1", "acc", "boom")).rejects.toThrow(
      /unsupported volume action "boom"/,
    );
  });
});

describe("executeVolumeCommand", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("volume-resize validates the size and posts it", async () => {
    const ctx = makeCtx({
      getResource: vi.fn().mockResolvedValue(makeResource({ region: "nyc3" })),
      fetch: vi.fn().mockResolvedValue({}),
    });
    await expect(
      executeVolumeCommand(
        ctx,
        "acc:volume:vol-1",
        "acc",
        "volume-resize",
        encodeArgs({ sizeGb: "0" }),
      ),
    ).rejects.toThrow(/New size in GiB is required/);
    await executeVolumeCommand(
      ctx,
      "acc:volume:vol-1",
      "acc",
      "volume-resize",
      encodeArgs({ sizeGb: "50" }),
    );
    const body = JSON.parse((ctx.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "resize", size_gigabytes: 50, region: "nyc3" });
  });

  it("volume-snapshot requires a name", async () => {
    const ctx = makeCtx();
    await expect(
      executeVolumeCommand(ctx, "acc:volume:vol-1", "acc", "volume-snapshot", encodeArgs({})),
    ).rejects.toThrow(/Snapshot name is required/);
    await executeVolumeCommand(
      ctx,
      "acc:volume:vol-1",
      "acc",
      "volume-snapshot",
      encodeArgs({ name: "v-snap" }),
    );
    expect(ctx.fetch).toHaveBeenCalledWith("/volumes/vol-1/snapshots", expect.any(Object));
  });

  it("rejects an unknown volume command", async () => {
    const ctx = makeCtx();
    await expect(
      executeVolumeCommand(ctx, "acc:volume:vol-1", "acc", "explode", encodeArgs({})),
    ).rejects.toThrow(/unknown volume command "explode"/);
  });
});
