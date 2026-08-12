/**
 * Ejection has to reach the socket, not just the row.
 *
 * The hub's registry is process memory and web runs two replicas, so an
 * ejection is an HTTP call that lands on one of them and a live pty that may
 * be on the other. The replica holding the pty learns about it by re-reading
 * the participant list — and re-reading is only half the job. If it swaps the
 * array in and stops there, the ejected guest's socket is still in the fan-out
 * map, still receiving every byte of somebody else's production terminal, and
 * "removed" means removed from a list rather than removed from the session.
 *
 * That is what these tests pin. They drive the hub through its real code path
 * with the database stubbed out, because the bug is not in any decision — the
 * pure arbitration functions get this right, and are tested separately — it is
 * in whether the transport acts on what they say.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ParticipantRow,
  SharedConsoleRow,
} from "@infrawrench/server-core/shared-console/store";

/** The participant list the "database" currently holds, per share. */
let storedParticipants: ParticipantRow[] = [];
let storedShare: SharedConsoleRow | null = null;

vi.mock("@infrawrench/server-core/shared-console/store", () => ({
  closeSharedConsole: vi.fn().mockResolvedValue(null),
  getSharedConsoleByLiveId: vi.fn(async () => storedShare),
  listParticipants: vi.fn(async () => storedParticipants),
  readShareStates: vi.fn(async () => new Map()),
  recordViewport: vi.fn().mockResolvedValue(undefined),
  setPtySize: vi.fn().mockResolvedValue(undefined),
  touchParticipant: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: vi
    .fn()
    .mockResolvedValue({ permissions: ["resources:execute"], role: null, elevations: [] }),
}));

const { SharedConsoleHub } = await import("../shared-console/hub");

const LIVE_ID = "live-console-1";
const SHARE_ID = "share-1";

function share(overrides: Partial<SharedConsoleRow> = {}): SharedConsoleRow {
  return {
    id: SHARE_ID,
    organizationId: "org-1",
    liveConsoleId: LIVE_ID,
    routingKey: "r".repeat(32),
    ownerUserId: "owner",
    ownerName: "Priya",
    accountId: "acct-1",
    resourceId: "res-1",
    host: "db-prod-1",
    port: 22,
    username: "root",
    recordingId: null,
    inviteTokenPrefix: "abc123",
    inviteExpiresAt: new Date(Date.now() + 600_000),
    inviteConsumedAt: null,
    allowHandover: true,
    ptyCols: 120,
    ptyRows: 40,
    status: "active",
    revokedAt: null,
    endedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function participant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "p-owner",
    sharedConsoleId: SHARE_ID,
    userId: "owner",
    userName: "Priya",
    role: "driver",
    status: "joined",
    driverRequestedAt: null,
    viewportCols: 120,
    viewportRows: 40,
    joinedAt: new Date(),
    lastSeenAt: new Date(),
    leftAt: null,
    ...overrides,
  };
}

/** A `ws`-shaped stub that records what the hub sent it. */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    sent,
    closed: false,
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close() {
      this.closed = true;
      this.readyState = 3;
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      listeners.set(event, fn);
    },
    frames(type: string) {
      return sent.filter((f) => f.type === type);
    },
  };
}

function fakeHandle(written: Buffer[], ownerFrames: Record<string, unknown>[]) {
  return {
    organizationId: "org-1",
    ownerUserId: "owner",
    accountId: "acct-1",
    resourceId: "res-1",
    host: "db-prod-1",
    port: 22,
    username: "root",
    write: (data: Buffer) => written.push(data),
    resize: vi.fn(),
    recorder: () => null,
    close: vi.fn(),
    sendToOwner: (frame: Record<string, unknown>) => ownerFrames.push(frame),
  };
}

/**
 * A hub with one shared console, an owner-driver and one attached guest —
 * the state every test below starts from.
 */
async function setup(guestOverrides: Partial<ParticipantRow> = {}) {
  const hub = new SharedConsoleHub();
  const written: Buffer[] = [];
  const ownerFrames: Record<string, unknown>[] = [];
  const guestSocket = fakeSocket();

  const owner = participant();
  const guest = participant({
    id: "p-guest",
    userId: "guest",
    userName: "Sam",
    role: "observer",
    ...guestOverrides,
  });
  storedShare = share();
  storedParticipants = [owner, guest];

  hub.register(LIVE_ID, fakeHandle(written, ownerFrames), 120, 40);
  await hub.bindShare(LIVE_ID, storedShare, owner);
  const attached = hub.attach({
    ws: guestSocket as never,
    liveConsoleId: LIVE_ID,
    share: storedShare,
    participant: guest,
    participants: storedParticipants,
  });
  expect(attached.ok).toBe(true);

  return { hub, written, ownerFrames, guestSocket, owner, guest };
}

beforeEach(() => {
  storedParticipants = [];
  storedShare = null;
});

describe("a guest ejected through another replica", () => {
  /**
   * The regression. The ejection route ran on the replica that does *not* hold
   * the pty: all it could do was write the row. This replica finds out by
   * re-reading the list, which is exactly the moment it has to hang up.
   */
  it("is detached from the live pty when the refreshed list says they are removed", async () => {
    const { hub, guestSocket, owner } = await setup();

    // Out-of-band: the other replica marked them removed. `detachParticipant`
    // writes `status: "removed"` and demotes the role in the same statement.
    storedParticipants = [
      owner,
      participant({
        id: "p-guest",
        userId: "guest",
        userName: "Sam",
        role: "observer",
        status: "removed",
        leftAt: new Date(),
      }),
    ];

    await hub.refresh(SHARE_ID);

    const detached = guestSocket.frames("console:detached");
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatchObject({ reason: "removed" });
    expect(String(detached[0]!.message)).toMatch(/removed from this shared console/i);
  });

  it("stops receiving terminal output immediately after that refresh", async () => {
    const { hub, guestSocket, owner } = await setup();

    hub.broadcastOutput(LIVE_ID, Buffer.from("before"));
    expect(guestSocket.frames("console:data")).toHaveLength(1);

    storedParticipants = [
      owner,
      participant({ id: "p-guest", userId: "guest", status: "removed" }),
    ];
    await hub.refresh(SHARE_ID);

    // The fan-out must not reach them again — this is the part that leaked a
    // colleague's production terminal for as long as the socket stayed in the
    // map, which was until the far slower permission sweep noticed.
    hub.broadcastOutput(LIVE_ID, Buffer.from("after"));
    expect(guestSocket.frames("console:data")).toHaveLength(1);
  });

  it("does not send them a final state frame on the way out", async () => {
    const { hub, guestSocket, owner } = await setup();
    const before = guestSocket.frames("console:state").length;

    storedParticipants = [
      owner,
      participant({ id: "p-guest", userId: "guest", status: "removed" }),
    ];
    await hub.refresh(SHARE_ID);

    expect(guestSocket.frames("console:state")).toHaveLength(before);
  });

  /**
   * The sharper half of the same bug: an ejected *driver* kept the attachment
   * that input travels on. Two independent things must stop them — the socket
   * leaving `attached`, and `evaluateInput` refusing a row that is no longer
   * `joined`.
   */
  it("cannot type into the pty afterwards, even if they held the keyboard", async () => {
    const { hub, written, owner } = await setup({ role: "driver" });
    // The owner is demoted so the fixture has exactly one driver, the guest.
    storedParticipants = [
      participant({ role: "observer" }),
      participant({ id: "p-guest", userId: "guest", role: "driver" }),
    ];
    await hub.refresh(SHARE_ID);

    hub.handleAttachedMessage(LIVE_ID, "p-guest", {
      type: "console:input",
      data: Buffer.from("id\n").toString("base64"),
    });
    expect(written).toHaveLength(1);

    storedParticipants = [
      owner,
      participant({ id: "p-guest", userId: "guest", status: "removed" }),
    ];
    await hub.refresh(SHARE_ID);

    hub.handleAttachedMessage(LIVE_ID, "p-guest", {
      type: "console:input",
      data: Buffer.from("rm -rf /\n").toString("base64"),
    });
    expect(written).toHaveLength(1);
  });

  it("is detached when their row disappears entirely, not only when it says removed", async () => {
    const { hub, guestSocket, owner } = await setup();
    storedParticipants = [owner];
    await hub.refresh(SHARE_ID);
    expect(guestSocket.frames("console:detached")).toHaveLength(1);
  });

  it("is detached on a voluntary departure processed elsewhere, with the right wording", async () => {
    const { hub, guestSocket, owner } = await setup();
    storedParticipants = [
      owner,
      participant({ id: "p-guest", userId: "guest", status: "left", leftAt: new Date() }),
    ];
    await hub.refresh(SHARE_ID);

    const detached = guestSocket.frames("console:detached");
    expect(detached).toHaveLength(1);
    expect(String(detached[0]!.message)).toMatch(/you left/i);
  });
});

describe("a guest who is still on the console", () => {
  it("is left alone by a refresh, and keeps receiving output", async () => {
    const { hub, guestSocket, owner, guest } = await setup();
    storedParticipants = [owner, guest];
    await hub.refresh(SHARE_ID);

    expect(guestSocket.frames("console:detached")).toHaveLength(0);
    hub.broadcastOutput(LIVE_ID, Buffer.from("still here"));
    expect(guestSocket.frames("console:data")).toHaveLength(1);
  });

  it("still cannot type while they are an observer", async () => {
    const { hub, written } = await setup();
    hub.handleAttachedMessage(LIVE_ID, "p-guest", {
      type: "console:input",
      data: Buffer.from("whoami\n").toString("base64"),
    });
    expect(written).toHaveLength(0);
  });
});

describe("revocation", () => {
  it("detaches everyone and stops the fan-out", async () => {
    const { hub, guestSocket } = await setup();
    hub.revokeLocal(SHARE_ID);

    expect(guestSocket.frames("console:detached")).toHaveLength(1);
    hub.broadcastOutput(LIVE_ID, Buffer.from("after revoke"));
    expect(guestSocket.frames("console:data")).toHaveLength(0);
  });

  it("reaches this replica through refresh when the revoke landed on the other one", async () => {
    const { hub, guestSocket } = await setup();
    storedShare = share({ status: "revoked", revokedAt: new Date() });
    await hub.refresh(SHARE_ID);

    expect(guestSocket.frames("console:detached")).toHaveLength(1);
    hub.broadcastOutput(LIVE_ID, Buffer.from("after revoke"));
    expect(guestSocket.frames("console:data")).toHaveLength(0);
  });
});

describe("session teardown", () => {
  it("detaches guests when the underlying SSH session closes", async () => {
    const { hub, guestSocket } = await setup();
    hub.unregister(LIVE_ID);

    expect(guestSocket.frames("console:detached")).toHaveLength(1);
    // The console is gone; a late output tee must not throw.
    expect(() => hub.broadcastOutput(LIVE_ID, Buffer.from("late"))).not.toThrow();
  });
});
