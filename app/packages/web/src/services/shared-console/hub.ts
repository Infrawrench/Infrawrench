/**
 * The live half of shared consoles: one pty, several sockets.
 *
 * `ssh-proxy.ts` registers every cloud SSH session here the moment its shell
 * opens, shared or not. Registration is unconditional so that sharing a
 * session already in progress needs nothing from the pty — the handle is
 * already in the map, and creating the share row is all that changes. An
 * unshared console costs one map entry and one branch per data event.
 *
 * ## Where this runs, and the one thing to know about it
 *
 * The registry is **process memory**, like the bastion dispatcher registry it
 * sits beside. Web runs two replicas, so the joiner's WebSocket has to reach
 * the replica holding the pty. That is what `routingKey` is for: the sharer's
 * browser mints one, puts it in its own `/api/ws?sid=…`, and the ingress
 * consistently hashes `$arg_sid` to a backend (`infra/k8s/web-ws-ingress.yaml`).
 * A joiner is told the same `sid` and lands on the same pod.
 *
 * When that fails anyway — a rolling deploy moved the pod, the annotation is
 * not in effect, somebody is running a single instance behind a round-robin
 * proxy — the joiner gets a typed `console:error` with `code:
 * "console_not_here"` rather than a socket that connects and then shows
 * nothing. The client retries a bounded number of times on a fresh token,
 * which converges quickly across a small replica set, and then says so. This
 * is a real limitation and it is written down rather than papered over; the
 * durable fix is a cross-replica relay, which is the same follow-up the
 * bastion registry is waiting on.
 *
 * ## What is enforced here
 *
 * Nothing is *decided* here — every decision is a pure function in
 * `@infrawrench/server-core/shared-console/arbitration`. This module reads
 * state, calls those functions, and does what they say. In particular an
 * observer's keystrokes are dropped in {@link SharedConsoleHub.handleInput}
 * on the server, not hidden by a client that could simply not hide them.
 */
import type { WebSocket } from "ws";

import {
  CONSOLE_PERMISSION,
  evaluateAttached,
  evaluateInput,
  resolvePtySize,
  type DetachReason,
} from "@infrawrench/server-core/shared-console/arbitration";
import {
  closeSharedConsole,
  getSharedConsoleByLiveId,
  listParticipants,
  readShareStates,
  recordViewport,
  setPtySize,
  touchParticipant,
  type ParticipantRow,
  type SharedConsoleRow,
} from "@infrawrench/server-core/shared-console/store";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import type {
  RecordingParticipant,
  SessionRecorder,
} from "@infrawrench/server-core/ssh-recording/recorder";

import { recordingParticipantsOf } from "./attribution";

/**
 * How often the hub re-reads share status from the database.
 *
 * Revocation is an HTTP call that can land on either replica, so the replica
 * holding the pty learns about it either directly (same pod — the route calls
 * {@link SharedConsoleHub.revokeLocal}) or on this sweep. Two seconds is the
 * honest number to quote for "immediately": short enough that a revoke feels
 * instant to the person clicking it, long enough that a shared session costs
 * one small indexed query every two seconds and an unshared one costs nothing
 * (the sweep does not run when no share is live on this replica).
 */
const SWEEP_INTERVAL_MS = 2_000;

/**
 * How often each participant's permissions are re-derived.
 *
 * More expensive than the status read — a role lookup per participant — and a
 * slower-moving fact, so it rides every fifteenth sweep rather than every one.
 * Thirty seconds is the window in which somebody whose access was just
 * withdrawn can still see the terminal, and it is stated plainly in the docs
 * rather than rounded down to "immediately".
 */
const PERMISSION_SWEEP_EVERY = 15;

/**
 * When an observer's socket has this much unsent data, cut them off.
 *
 * The operator's own socket gets ordinary backpressure — pause the pty until
 * the browser catches up. An observer must never get that treatment: a
 * colleague on hotel wifi would otherwise stall the shell of the person
 * fixing production. So a slow observer is dropped with a message instead,
 * which is the right trade every time.
 */
const OBSERVER_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

/** The pty side of a live console, as `ssh-proxy` exposes it. */
export interface LiveConsoleHandle {
  organizationId: string;
  ownerUserId: string | undefined;
  /**
   * Where this session actually is, as the proxy dialled it.
   *
   * The create-share route copies these onto the share row instead of reading
   * them from its request body. A browser that could name its own host would
   * be able to open a share that advertises one box and hands out a shell on
   * another, which is a phishing primitive rather than a feature.
   */
  accountId: string | undefined;
  resourceId: string | undefined;
  host: string;
  port: number;
  username: string;
  /** Write bytes to the pty. */
  write(data: Buffer): void;
  /** Set the pty window. */
  resize(cols: number, rows: number): void;
  /** The recorder tee, when the org records. Markers are written through it. */
  recorder(): SessionRecorder | null;
  /** Tear the whole session down (used when the owner loses permission). */
  close(): void;
  /** Send a frame to the originating (sharer's) socket. */
  sendToOwner(frame: Record<string, unknown>): void;
}

interface AttachedSocket {
  ws: WebSocket;
  userId: string;
  participantId: string;
}

interface LiveConsole {
  id: string;
  handle: LiveConsoleHandle;
  /** The share row id, once the session has been shared. Null while solo. */
  sharedConsoleId: string | null;
  /** Cached share + participants, refreshed by the sweep and on every mutation. */
  share: SharedConsoleRow | null;
  participants: ParticipantRow[];
  /** The owner's own participant row id, once shared. */
  ownerParticipantId: string | null;
  attached: Map<string, AttachedSocket>;
  /**
   * The attribution written to the recording so far. Kept here so that
   * "highest role held" accumulates across the session rather than being
   * recomputed from whoever happens to be driving right now.
   */
  attribution: RecordingParticipant[];
  ptyCols: number;
  ptyRows: number;
}

export class SharedConsoleHub {
  private readonly consoles = new Map<string, LiveConsole>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepCount = 0;

  /** Called by `ssh-proxy` when a shell opens. */
  register(
    liveConsoleId: string,
    handle: LiveConsoleHandle,
    ptyCols: number,
    ptyRows: number,
  ): void {
    this.consoles.set(liveConsoleId, {
      id: liveConsoleId,
      handle,
      sharedConsoleId: null,
      share: null,
      participants: [],
      ownerParticipantId: null,
      attached: new Map(),
      attribution: [],
      ptyCols,
      ptyRows,
    });
  }

  /**
   * Called by `ssh-proxy` on teardown.
   *
   * Detaches everyone and settles the share as `ended`. The DB write is
   * fire-and-forget because the terminal's teardown path must not wait on it —
   * a share whose closing write is lost is settled by the next reader, which
   * finds a share whose live console no longer exists.
   */
  unregister(liveConsoleId: string): void {
    const live = this.consoles.get(liveConsoleId);
    if (!live) return;
    this.consoles.delete(liveConsoleId);
    for (const socket of live.attached.values()) {
      this.detachSocket(live, socket, "share-ended", "The session ended.");
    }
    if (live.sharedConsoleId) {
      void closeSharedConsole(live.sharedConsoleId, "ended").catch((err) =>
        console.error(`[shared-console] settling ${live.sharedConsoleId} as ended failed:`, err),
      );
    }
    this.stopSweepIfIdle();
  }

  has(liveConsoleId: string): boolean {
    return this.consoles.has(liveConsoleId);
  }

  /**
   * What the create-share route needs to know about a pty on this replica.
   *
   * Null when the console is not here — which the route reports as "reopen the
   * terminal and try again" rather than writing a share row pointing at a
   * process that does not hold the session.
   */
  describe(liveConsoleId: string): {
    organizationId: string;
    ownerUserId: string | undefined;
    accountId: string | undefined;
    resourceId: string | undefined;
    host: string;
    port: number;
    username: string;
    recordingId: string | null;
    alreadyShared: string | null;
    ptyCols: number;
    ptyRows: number;
  } | null {
    const live = this.consoles.get(liveConsoleId);
    if (!live) return null;
    return {
      organizationId: live.handle.organizationId,
      ownerUserId: live.handle.ownerUserId,
      accountId: live.handle.accountId,
      resourceId: live.handle.resourceId,
      host: live.handle.host,
      port: live.handle.port,
      username: live.handle.username,
      recordingId: live.handle.recorder()?.recordingId ?? null,
      alreadyShared: live.sharedConsoleId,
      ptyCols: live.ptyCols,
      ptyRows: live.ptyRows,
    };
  }

  /** Is this session shared? Drives the input gate in `ssh-proxy`. */
  isShared(liveConsoleId: string): boolean {
    return this.consoles.get(liveConsoleId)?.sharedConsoleId != null;
  }

  /**
   * Bind a freshly created share row to the live pty.
   *
   * Returns false when the pty is not on this replica, which is how the create
   * route learns it must refuse rather than write a share nobody can attach to.
   */
  async bindShare(
    liveConsoleId: string,
    share: SharedConsoleRow,
    ownerParticipant: ParticipantRow,
  ): Promise<boolean> {
    const live = this.consoles.get(liveConsoleId);
    if (!live) return false;
    live.sharedConsoleId = share.id;
    live.share = share;
    live.participants = [ownerParticipant];
    live.ownerParticipantId = ownerParticipant.id;
    live.handle.recorder()?.mark(`share opened by ${ownerParticipant.userName ?? "unknown"}`);
    this.pushAttribution(live);
    this.broadcastState(live);
    this.startSweep();
    return true;
  }

  /** The pty output tee. Called for every chunk, shared or not. */
  broadcastOutput(liveConsoleId: string, data: Buffer): void {
    const live = this.consoles.get(liveConsoleId);
    if (!live || live.attached.size === 0) return;
    const frame = JSON.stringify({ type: "console:data", data: data.toString("base64") });
    for (const socket of live.attached.values()) {
      if (socket.ws.readyState !== socket.ws.OPEN) continue;
      if (socket.ws.bufferedAmount > OBSERVER_BUFFER_LIMIT_BYTES) {
        this.detachSocket(
          live,
          socket,
          "share-ended",
          "Your connection could not keep up with this session's output.",
        );
        continue;
      }
      socket.ws.send(frame);
    }
  }

  /**
   * The input gate, for the owner's own socket.
   *
   * An unshared session is unchanged — true, always. A shared one asks
   * `evaluateInput` about the owner's participant row, which is how the owner
   * stops being able to type the moment they hand the keyboard over.
   */
  ownerMayWrite(liveConsoleId: string): boolean {
    const live = this.consoles.get(liveConsoleId);
    if (!live) return true;
    if (!live.share || !live.ownerParticipantId) return true;
    const participant = live.participants.find((p) => p.id === live.ownerParticipantId) ?? null;
    return evaluateInput({
      share: shareStateOf(live.share),
      participant: participant && {
        id: participant.id,
        userId: participant.userId,
        role: participant.role,
        status: participant.status,
      },
    });
  }

  /** Whether the owner's resize should reach the pty (i.e. they are driving). */
  ownerMayResize(liveConsoleId: string): boolean {
    return this.ownerMayWrite(liveConsoleId);
  }

  /**
   * Record the sharer's window size without applying it.
   *
   * Called on every resize the owner's browser reports, driving or not. While
   * they are letterboxed the number changes nothing; the moment the keyboard
   * comes back to them it is what the pty is resized to.
   */
  noteOwnerViewport(liveConsoleId: string, cols: number, rows: number): void {
    const live = this.consoles.get(liveConsoleId);
    if (!live?.ownerParticipantId) return;
    const owner = live.participants.find((p) => p.id === live.ownerParticipantId);
    if (owner) {
      owner.viewportCols = cols;
      owner.viewportRows = rows;
    }
    void recordViewport(live.ownerParticipantId, cols, rows).catch(() => undefined);
  }

  /** Record the pty geometry the proxy actually applied. */
  notePtySize(liveConsoleId: string, cols: number, rows: number): void {
    const live = this.consoles.get(liveConsoleId);
    if (!live) return;
    live.ptyCols = cols;
    live.ptyRows = rows;
    if (live.sharedConsoleId) {
      void setPtySize(live.sharedConsoleId, cols, rows).catch(() => undefined);
      this.broadcastPtySize(live);
    }
  }

  // ---------------------------------------------------------------- attaching

  /**
   * Attach an observer's socket to a live console.
   *
   * The caller has already resolved the participant row and re-checked
   * permissions over HTTP; this is the transport step. Returns a typed failure
   * when the pty is not on this replica, which is the cross-replica case the
   * module comment describes.
   */
  attach(input: {
    ws: WebSocket;
    liveConsoleId: string;
    share: SharedConsoleRow;
    participant: ParticipantRow;
    participants: ParticipantRow[];
  }): { ok: true } | { ok: false; code: "console_not_here" | "console_not_shared" } {
    const live = this.consoles.get(input.liveConsoleId);
    if (!live) return { ok: false, code: "console_not_here" };
    if (live.sharedConsoleId !== input.share.id) return { ok: false, code: "console_not_shared" };

    live.share = input.share;
    live.participants = input.participants;

    // A second socket for the same person replaces the first: two tabs on one
    // shared console is a duplicated fan-out and an ambiguous driver.
    const previous = live.attached.get(input.participant.id);
    if (previous) {
      this.sendFrame(previous.ws, {
        type: "console:detached",
        reason: "replaced",
        message: "You joined this console from another tab.",
      });
      try {
        previous.ws.close();
      } catch {
        /* already gone */
      }
    }

    const socket: AttachedSocket = {
      ws: input.ws,
      userId: input.participant.userId,
      participantId: input.participant.id,
    };
    live.attached.set(input.participant.id, socket);

    input.ws.on("close", () => {
      if (live.attached.get(input.participant.id) === socket) {
        live.attached.delete(input.participant.id);
        this.broadcastState(live);
      }
    });

    this.sendFrame(input.ws, {
      type: "console:attached",
      participantId: input.participant.id,
      role: input.participant.role,
      ptySize: { cols: live.ptyCols, rows: live.ptyRows },
    });
    live.handle
      .recorder()
      ?.mark(`joined: ${input.participant.userName ?? input.participant.userId} (observer)`);
    this.pushAttribution(live);
    this.broadcastState(live);
    this.startSweep();
    return { ok: true };
  }

  /**
   * Handle one inbound frame from an attached socket.
   *
   * Input is gated by {@link evaluateInput} against the participant's *current*
   * role, which the sweep and every role change keep fresh. A frame from an
   * observer is dropped silently — see the note in `arbitration.ts` on why
   * there is no reply.
   */
  handleAttachedMessage(
    liveConsoleId: string,
    participantId: string,
    msg: { type: string; data?: string; cols?: number; rows?: number },
  ): void {
    const live = this.consoles.get(liveConsoleId);
    if (!live || !live.share) return;
    const socket = live.attached.get(participantId);
    if (!socket) return;
    const participant = live.participants.find((p) => p.id === participantId) ?? null;

    if (msg.type === "console:input" && typeof msg.data === "string") {
      const allowed = evaluateInput({
        share: shareStateOf(live.share),
        participant: participant && {
          id: participant.id,
          userId: participant.userId,
          role: participant.role,
          status: participant.status,
        },
      });
      if (!allowed) return;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(msg.data, "base64");
      } catch {
        return;
      }
      live.handle.write(bytes);
      live.handle.recorder()?.onInput(bytes);
      return;
    }

    if (msg.type === "console:viewport" && msg.cols && msg.rows) {
      // Recorded for everyone, applied only for the driver — a handover then
      // resizes to something the new driver can actually read.
      if (participant) {
        participant.viewportCols = msg.cols;
        participant.viewportRows = msg.rows;
      }
      if (participant?.role === "driver") {
        const size = resolvePtySize(
          { cols: msg.cols, rows: msg.rows },
          { cols: live.ptyCols, rows: live.ptyRows },
        );
        live.handle.resize(size.cols, size.rows);
        this.notePtySize(liveConsoleId, size.cols, size.rows);
      }
      void touchParticipant(participantId).catch(() => undefined);
      return;
    }
  }

  /** Detach one participant's socket, if they have one on this replica. */
  detach(
    liveConsoleId: string,
    participantId: string,
    reason: DetachReason,
    message: string,
  ): void {
    const live = this.consoles.get(liveConsoleId);
    if (!live) return;
    const socket = live.attached.get(participantId);
    if (!socket) return;
    this.detachSocket(live, socket, reason, message);
    this.broadcastState(live);
  }

  // -------------------------------------------------------- state propagation

  /**
   * Refresh the cached share + participants after an HTTP mutation and push
   * the new state to everyone. Called by the routes on the replica they landed
   * on; the sweep does the same thing for the other one.
   */
  async refresh(sharedConsoleId: string): Promise<void> {
    const live = this.findBySharedConsoleId(sharedConsoleId);
    if (!live) return;
    const [share, participants] = await Promise.all([
      getSharedConsoleByLiveId(live.id),
      listParticipants(sharedConsoleId),
    ]);
    if (!share) return;
    live.share = share;
    live.participants = participants;
    this.applyDriverGeometry(live);
    this.pushAttribution(live);
    this.broadcastState(live);
    if (share.status !== "active") this.tearDownShare(live, share.status);
  }

  /** Called by the revoke route when the pty happens to be on this replica. */
  revokeLocal(sharedConsoleId: string): void {
    const live = this.findBySharedConsoleId(sharedConsoleId);
    if (!live) return;
    this.tearDownShare(live, "revoked");
  }

  /** Note a marker on the tape from an HTTP action (join, handover, revoke). */
  mark(sharedConsoleId: string, label: string): void {
    this.findBySharedConsoleId(sharedConsoleId)?.handle.recorder()?.mark(label);
  }

  private findBySharedConsoleId(sharedConsoleId: string): LiveConsole | null {
    for (const live of this.consoles.values()) {
      if (live.sharedConsoleId === sharedConsoleId) return live;
    }
    return null;
  }

  /**
   * The pty follows whoever is driving.
   *
   * Applied after any role change: the new driver's last-reported viewport
   * becomes the pty's geometry, and every other attached terminal is told to
   * letterbox that size rather than reflow to its own.
   */
  private applyDriverGeometry(live: LiveConsole): void {
    const driver = live.participants.find((p) => p.role === "driver" && p.status === "joined");
    if (!driver) return;
    const size = resolvePtySize(
      { cols: driver.viewportCols, rows: driver.viewportRows },
      { cols: live.ptyCols, rows: live.ptyRows },
    );
    if (size.cols === live.ptyCols && size.rows === live.ptyRows) return;
    live.handle.resize(size.cols, size.rows);
    live.handle.recorder()?.onResize(size.cols, size.rows);
    live.ptyCols = size.cols;
    live.ptyRows = size.rows;
    if (live.sharedConsoleId)
      void setPtySize(live.sharedConsoleId, size.cols, size.rows).catch(() => undefined);
    this.broadcastPtySize(live);
  }

  /**
   * Tell everyone the pty's geometry, and each of them whether it is theirs.
   *
   * `youAreDriver` is per-recipient rather than a shared field because the
   * driver's own terminal must keep owning its size (its fit addon still runs)
   * while every other terminal switches to letterboxing the announced grid.
   * Without it each client would have to work out its own role from the
   * participant list, which means each client would have to know its own user
   * id, which is a fact the socket already has and the browser should not have
   * to re-derive.
   */
  private broadcastPtySize(live: LiveConsole): void {
    const driverId = live.participants.find(
      (p) => p.role === "driver" && p.status === "joined",
    )?.id;
    const base = { type: "console:pty-size", cols: live.ptyCols, rows: live.ptyRows };
    live.handle.sendToOwner({
      ...base,
      youAreDriver: driverId === undefined || driverId === live.ownerParticipantId,
    });
    for (const socket of live.attached.values()) {
      this.sendFrame(socket.ws, { ...base, youAreDriver: driverId === socket.participantId });
    }
  }

  private broadcastState(live: LiveConsole): void {
    if (!live.share) return;
    const base = {
      type: "console:state",
      share: publicShare(live.share),
      participants: live.participants.filter((p) => p.status !== "left").map(publicParticipant),
      ptySize: { cols: live.ptyCols, rows: live.ptyRows },
    };
    live.handle.sendToOwner({ ...base, youParticipantId: live.ownerParticipantId });
    for (const socket of live.attached.values()) {
      this.sendFrame(socket.ws, { ...base, youParticipantId: socket.participantId });
    }
    // Geometry rides with membership: a handover is exactly when somebody
    // starts, or stops, owning the size.
    this.broadcastPtySize(live);
  }

  /** Write the current membership into the recording's attribution column. */
  private pushAttribution(live: LiveConsole): void {
    if (!live.sharedConsoleId) return;
    live.attribution = recordingParticipantsOf(live.participants, live.attribution);
    live.handle.recorder()?.setParticipants(live.sharedConsoleId, live.attribution);
  }

  private tearDownShare(live: LiveConsole, status: "revoked" | "ended"): void {
    const message =
      status === "revoked" ? "The sharer revoked this console." : "The session ended.";
    live.handle.recorder()?.mark(status === "revoked" ? "share revoked" : "share ended");
    for (const socket of live.attached.values()) {
      this.detachSocket(
        live,
        socket,
        status === "revoked" ? "share-revoked" : "share-ended",
        message,
      );
    }
    live.sharedConsoleId = null;
    live.share = null;
    live.ownerParticipantId = null;
    live.participants = [];
    live.handle.sendToOwner({ type: "console:ended", reason: status });
    this.stopSweepIfIdle();
  }

  private detachSocket(
    live: LiveConsole,
    socket: AttachedSocket,
    reason: DetachReason | "replaced",
    message: string,
  ): void {
    live.attached.delete(socket.participantId);
    this.sendFrame(socket.ws, { type: "console:detached", reason, message });
    // Give the frame a tick to leave before the socket goes, so the joiner
    // sees why rather than an unexplained close.
    setTimeout(() => {
      try {
        socket.ws.close();
      } catch {
        /* already gone */
      }
    }, 50).unref();
  }

  private sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* the close handler will clean up */
    }
  }

  // ------------------------------------------------------------------- sweep

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private stopSweepIfIdle(): void {
    if (!this.sweepTimer) return;
    for (const live of this.consoles.values()) if (live.sharedConsoleId) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Re-read what this replica cannot be told directly.
   *
   * Revocation and role changes are HTTP calls that can land on either
   * replica. The one holding the pty finds out here. Permissions are re-derived
   * every {@link PERMISSION_SWEEP_EVERY} sweeps because they are the expensive
   * half and the slow-moving one.
   */
  private async sweep(): Promise<void> {
    const shared = [...this.consoles.values()].filter((c) => c.sharedConsoleId);
    if (shared.length === 0) {
      this.stopSweepIfIdle();
      return;
    }
    this.sweepCount++;
    const checkPermissions = this.sweepCount % PERMISSION_SWEEP_EVERY === 0;

    let states: Map<string, SharedConsoleRow>;
    try {
      states = await readShareStates(shared.map((c) => c.sharedConsoleId!));
    } catch (err) {
      // Failing open here means "keep the session as it is", which is the only
      // sane response to a database blip: tearing every shared session down
      // because one query timed out would be its own outage.
      console.error("[shared-console] sweep read failed:", err);
      return;
    }

    for (const live of shared) {
      const share = states.get(live.sharedConsoleId!);
      if (!share) continue;
      const changedRole = share.status === "active" && this.participantsChanged(live, share);
      live.share = share;
      if (share.status !== "active") {
        this.tearDownShare(live, share.status === "revoked" ? "revoked" : "ended");
        continue;
      }
      if (changedRole) {
        try {
          live.participants = await listParticipants(share.id);
          this.applyDriverGeometry(live);
          this.pushAttribution(live);
          this.broadcastState(live);
        } catch (err) {
          console.error(`[shared-console] participant refresh for ${share.id} failed:`, err);
        }
      }
      if (checkPermissions) await this.sweepPermissions(live, share);
    }
  }

  /**
   * A cheap "has anything moved" check between sweeps.
   *
   * The share row's `updated_at` moves on every mutation that matters (invite,
   * pty size, close) but not on a role change, which touches only the
   * participant rows — so the pessimistic answer is the right one here: any
   * share with attached sockets re-reads its participants each sweep. The
   * query is one indexed read of at most a handful of rows.
   */
  private participantsChanged(live: LiveConsole, _share: SharedConsoleRow): boolean {
    return live.attached.size > 0 || live.participants.length > 1;
  }

  private async sweepPermissions(live: LiveConsole, share: SharedConsoleRow): Promise<void> {
    for (const participant of live.participants) {
      if (participant.status !== "joined") continue;
      let permissions: readonly string[];
      try {
        const access = await resolveEffectivePermissions(share.organizationId, {
          kind: "user",
          userId: participant.userId,
        });
        permissions = access.permissions;
      } catch (err) {
        // Fail *closed* would end the session on a transient database error;
        // fail open leaves someone attached for another 30 seconds. Neither is
        // good, and the second is recoverable — the next sweep decides again.
        console.error(
          `[shared-console] permission re-check for ${participant.userId} failed:`,
          err,
        );
        continue;
      }
      const verdict = evaluateAttached({
        share: shareStateOf(share),
        participant: {
          id: participant.id,
          userId: participant.userId,
          role: participant.role,
          status: participant.status,
        },
        permissions,
      });
      if (verdict.keep) continue;

      live.handle
        .recorder()
        ?.mark(`detached: ${participant.userName ?? participant.userId} (${verdict.reason})`);

      // The owner losing the permission ends the whole session: the pty runs
      // on their authority, and continuing it for the benefit of the guests
      // would be exactly the loophole this check exists to close.
      if (participant.id === live.ownerParticipantId) {
        console.warn(
          `[shared-console] owner of ${share.id} lost ${CONSOLE_PERMISSION}; closing the session`,
        );
        live.handle.sendToOwner({
          type: "console:detached",
          reason: verdict.reason,
          message: verdict.message,
        });
        live.handle.close();
        return;
      }
      this.detach(live.id, participant.id, verdict.reason, verdict.message);
      participant.status = "removed";
    }
  }
}

/** Reduce a row to the fields the arbitration functions look at. */
function shareStateOf(share: SharedConsoleRow) {
  return {
    id: share.id,
    organizationId: share.organizationId,
    status: share.status,
    ownerUserId: share.ownerUserId,
    allowHandover: share.allowHandover,
    inviteTokenHash: null,
    inviteExpiresAt: share.inviteExpiresAt,
    inviteConsumedAt: share.inviteConsumedAt,
  };
}

/** What a client is allowed to see about the share. Never the invite digest. */
export function publicShare(share: SharedConsoleRow) {
  return {
    id: share.id,
    routingKey: share.routingKey,
    ownerUserId: share.ownerUserId,
    ownerName: share.ownerName,
    accountId: share.accountId,
    resourceId: share.resourceId,
    host: share.host,
    port: share.port,
    username: share.username,
    allowHandover: share.allowHandover,
    status: share.status,
    inviteTokenPrefix: share.inviteTokenPrefix,
    inviteExpiresAt: share.inviteExpiresAt?.toISOString() ?? null,
    inviteConsumedAt: share.inviteConsumedAt?.toISOString() ?? null,
    recordingId: share.recordingId,
    ptyCols: share.ptyCols,
    ptyRows: share.ptyRows,
    createdAt: share.createdAt.toISOString(),
  };
}

export function publicParticipant(participant: ParticipantRow) {
  return {
    id: participant.id,
    userId: participant.userId,
    userName: participant.userName,
    role: participant.role,
    status: participant.status,
    driverRequestedAt: participant.driverRequestedAt?.toISOString() ?? null,
    joinedAt: participant.joinedAt.toISOString(),
  };
}

/** One registry per process, like the bastion dispatcher registry. */
export const sharedConsoleHub = new SharedConsoleHub();
