/**
 * One run of a push mirror: make the target's branches and tags equal to
 * this repository's.
 *
 * **It mirrors a state, not an event.** A run asks the target what it has,
 * asks the repository what it has now, and pushes the difference. The push
 * that caused the run is not looked at, so runs can be repeated, skipped and
 * merged freely: the last one to finish after the last push leaves the
 * target right. What keeps an older run from landing after a newer one is
 * in `job.ts` (one run at a time holds the lease, and `stillMine` is asked
 * before every push) and on the wire (each command names the value the
 * target showed, so a ref that moved in between is refused, not
 * overwritten).
 *
 * **Objects are never rewritten.** The pack holds this repository's own
 * objects, byte for byte, so every commit and tag has the id it has here.
 *
 * **Size.** A run is one push when there is little to send and a series of
 * them along a branch's history when there is a lot (`plan.ts`). Each pack
 * is streamed from the repository's Durable Object into the request, so
 * nothing is held whole in the Worker; a pack past `maxPackBytes` is cut
 * off and the run starts again with smaller parts. A run that reaches its
 * deadline stops between pushes and says it is not finished.
 *
 * Nothing here reads Postgres, the environment or a clock of its own, and
 * nothing is logged: the caller is told what happened in words that carry
 * neither the address nor the credential.
 */
import { type ObjectId, ZERO_OID } from "@infrawrench/git-core";
import {
  type SendPackCommand,
  SendPackError,
  type SendPackFetch,
  type SendPackRemote,
  fetchReceiveAdvertisement,
  sendPack,
} from "@infrawrench/git-protocol";
import type { GitMirrorResult } from "@infrawrench/server-core/db/schema";
import { DEFAULT_MIRROR_PLAN, type MirrorPlan, type MirrorPlanOptions } from "./plan";

/** The repository, as much of it as a run needs: its Durable Object in production. */
export interface MirrorSource {
  mirrorPlan(options: MirrorPlanOptions): Promise<MirrorPlan>;
  mirrorPack(
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
    options: { readonly ofsDelta: boolean },
  ): Promise<ReadableStream<Uint8Array> | null>;
}

export interface MirrorTarget {
  /** Checked by `address.ts` before it gets here. */
  readonly url: string;
  /** The `Authorization` value. */
  readonly authorization: string;
  readonly exclude: readonly string[];
  readonly force: boolean;
}

export interface MirrorSyncLimits {
  /** A branch bringing more commits than this goes in parts (`plan.ts`). */
  readonly stepCommits: number;
  /** Below this a pack that is still too large is an error rather than cut smaller. */
  readonly minStepCommits: number;
  readonly maxTagsPerPush: number;
  readonly maxRefsPerPush: number;
  /**
   * The most bytes of one push. GitHub refuses a push over 2 GiB; half of
   * that leaves room and keeps one request well inside a queue consumer's
   * fifteen minutes.
   */
  readonly maxPackBytes: number;
  /** Refs deleted in one push. */
  readonly maxDeletesPerPush: number;
}

export const DEFAULT_MIRROR_LIMITS: MirrorSyncLimits = {
  ...DEFAULT_MIRROR_PLAN,
  minStepCommits: 25,
  maxPackBytes: 1024 * 1024 * 1024,
  maxDeletesPerPush: 500,
};

export interface MirrorSyncOptions {
  readonly fetch: SendPackFetch;
  /** Milliseconds since the epoch after which no further push is started. */
  readonly deadline: number;
  readonly now?: () => number;
  /** Asked before every push: false once another run has taken over, and this one stops. */
  readonly stillMine?: () => Promise<boolean>;
  readonly limits?: Partial<MirrorSyncLimits>;
  readonly signal?: AbortSignal;
}

export interface MirrorSyncOutcome {
  /**
   * `ok`: the target equals the repository (but for what `result.refused`
   * lists as left alone). `partial`: the deadline came first; run again.
   * `error`: something failed, `error` says what. `superseded`: another run
   * took over; nothing is to be recorded.
   */
  readonly status: "ok" | "partial" | "error" | "superseded";
  readonly error: string | null;
  readonly result: GitMirrorResult;
}

/** Entries kept of the refs that moved and of those refused. */
const MAX_LISTED = 50;

class PackTooLarge extends Error {}

/** `pack`, failing once more than `limit` bytes have gone through. */
const capped = (
  pack: ReadableStream<Uint8Array>,
  limit: number,
  over: () => void,
): ReadableStream<Uint8Array> => {
  let seen = 0;
  return pack.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          over();
          controller.error(new PackTooLarge());
        } else {
          controller.enqueue(chunk);
        }
      },
    }),
  );
};

/** What went wrong, as a sentence that is safe to store and show. */
const sentence = (error: unknown): string => {
  if (error instanceof SendPackError) return error.message;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "The target took too long to answer";
  }
  // A network error's own message can name the address: it is not repeated.
  return "The target could not be reached";
};

export async function syncMirror(
  source: MirrorSource,
  target: MirrorTarget,
  options: MirrorSyncOptions,
): Promise<MirrorSyncOutcome> {
  const limits: MirrorSyncLimits = { ...DEFAULT_MIRROR_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const stillMine = options.stillMine ?? (async () => true);
  const remote: SendPackRemote = {
    url: target.url,
    authorization: target.authorization,
    fetch: options.fetch,
    agent: "infrawrench-mirror",
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const created = new Set<string>();
  const updated = new Set<string>();
  const deleted = new Set<string>();
  const moved: string[] = [];
  const refused = new Map<string, string>();
  const result = (): GitMirrorResult => ({
    created: created.size,
    updated: updated.size,
    deleted: deleted.size,
    refused: [...refused].slice(0, MAX_LISTED).map(([ref, reason]) => ({ ref, reason })),
    refs: moved.slice(0, MAX_LISTED),
  });
  const failed = (error: string): MirrorSyncOutcome => ({
    status: "error",
    error,
    result: result(),
  });

  let stepCommits = limits.stepCommits;
  for (;;) {
    // Each pass starts from what the target has now: a pass that was cut
    // off (a pack too large) left its earlier pushes in place.
    let advertised;
    let plan: MirrorPlan;
    try {
      advertised = await fetchReceiveAdvertisement(remote);
      plan = await source.mirrorPlan({
        remote: [...advertised.refs].map(([name, oid]) => ({ name, oid })),
        exclude: target.exclude,
        force: target.force,
        stepCommits,
        maxTagsPerPush: limits.maxTagsPerPush,
        maxRefsPerPush: limits.maxRefsPerPush,
      });
    } catch (error) {
      return failed(sentence(error));
    }
    const offered = advertised.capabilities;
    const there = new Map(advertised.refs);
    const haves = new Set<ObjectId>([...plan.haves, ...advertised.extraHaves]);
    for (const { ref, reason } of plan.skipped) refused.set(ref, reason);
    /** Refs a push of this pass did not move: their later parts are not tried. */
    const stuck = new Set<string>();
    let tooLarge = false;
    let unreachable = false;

    const push = async (
      commands: readonly SendPackCommand[],
      pack: ReadableStream<Uint8Array> | null,
    ): Promise<"sent" | "too-large" | MirrorSyncOutcome> => {
      let over = false;
      let report;
      try {
        report = await sendPack(remote, {
          commands,
          offered,
          pack: pack === null ? null : capped(pack, limits.maxPackBytes, () => (over = true)),
        });
      } catch (error) {
        if (over || error instanceof PackTooLarge) return "too-large";
        return failed(sentence(error));
      }
      for (const command of commands) {
        const reason = report.refs.get(command.name) ?? null;
        if (reason !== null) {
          refused.set(command.name, reason);
          stuck.add(command.name);
          continue;
        }
        refused.delete(command.name);
        if (command.newOid === ZERO_OID) {
          there.delete(command.name);
          deleted.add(command.name);
        } else {
          if (!advertised.refs.has(command.name) && !updated.has(command.name)) {
            created.add(command.name);
          } else if (!created.has(command.name)) {
            updated.add(command.name);
          }
          there.set(command.name, command.newOid);
          haves.add(command.newOid);
        }
        if (!moved.includes(command.name)) moved.push(command.name);
      }
      if (report.unpackError !== null) {
        return failed(`The target could not take the objects: ${report.unpackError}`);
      }
      return "sent";
    };

    // Deletions first: a branch `a` that became `a/b` has to go before `a/b` can be made.
    for (let at = 0; at < plan.deletes.length; at += limits.maxDeletesPerPush) {
      if (now() > options.deadline) return { status: "partial", error: null, result: result() };
      if (!(await stillMine())) return { status: "superseded", error: null, result: result() };
      const commands = plan.deletes
        .slice(at, at + limits.maxDeletesPerPush)
        .map((name) => ({ name, oldOid: there.get(name) ?? ZERO_OID, newOid: ZERO_OID }));
      const outcome = await push(commands, null);
      if (typeof outcome !== "string") return outcome;
    }

    for (const stage of plan.stages) {
      const updates = stage.updates.filter((update) => !stuck.has(update.name));
      if (updates.length === 0) continue;
      if (now() > options.deadline) return { status: "partial", error: null, result: result() };
      if (!(await stillMine())) return { status: "superseded", error: null, result: result() };
      let pack: ReadableStream<Uint8Array> | null;
      try {
        pack = await source.mirrorPack(
          updates.map((update) => update.oid),
          [...haves],
          { ofsDelta: offered.has("ofs-delta") },
        );
      } catch {
        return failed("The repository's objects could not be read");
      }
      if (pack === null) {
        // A ref moved here while the run was under way. The push that moved
        // it has asked for another run, which sends what it is now.
        unreachable = true;
        for (const update of updates) stuck.add(update.name);
        continue;
      }
      const outcome = await push(
        updates.map((update) => ({
          name: update.name,
          oldOid: there.get(update.name) ?? ZERO_OID,
          newOid: update.oid,
        })),
        pack,
      );
      if (outcome === "too-large") {
        tooLarge = true;
        break;
      }
      if (typeof outcome !== "string") return outcome;
    }

    if (tooLarge) {
      if (stepCommits <= limits.minStepCommits) {
        return failed(
          "A part of the history is larger than one push to the target may be, however small the parts",
        );
      }
      stepCommits = Math.max(limits.minStepCommits, Math.floor(stepCommits / 4));
      continue;
    }
    if (unreachable) return { status: "partial", error: null, result: result() };
    const refusedByTarget = [...refused.keys()].filter((ref) => stuck.has(ref)).length;
    if (refusedByTarget > 0) {
      return failed(
        refusedByTarget === 1
          ? "The target refused one ref"
          : `The target refused ${refusedByTarget} refs`,
      );
    }
    return { status: "ok", error: null, result: result() };
  }
}
