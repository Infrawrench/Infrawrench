/**
 * `git-receive-pack`: the server side of push. The classic protocol only;
 * protocol v2 has no push, and a client that asked for v2 falls back when it
 * is answered in v0.
 */
import {
  FLUSH_PKT,
  GitError,
  type ObjectId,
  type ObjectReader,
  type RefUpdate,
  SIDE_BAND_64K_MAX_LENGTH,
  SIDE_BAND_DATA,
  SIDE_BAND_PROGRESS,
  ZERO_OID,
  concatBytes,
  encodePktLine,
  encodeSideBand,
  isValidRefName,
} from "@infrawrench/git-core";
import type { IngestedPack, ReceiveUpdate } from "./backend";
import {
  type Context,
  ProtocolError,
  lineOf,
  listRefs,
  parseCapabilities,
  parseOid,
} from "./common";
import { advertiseRefsV0 } from "./upload-pack";
import { CommitGraph, isAncestor } from "./walk";

const CAPABILITIES = [
  "report-status",
  "report-status-v2",
  "delete-refs",
  "side-band-64k",
  "quiet",
  "atomic",
  "ofs-delta",
  "push-options",
];

interface Command extends RefUpdate {
  error: string | null;
  kind: ReceiveUpdate["kind"];
  forced: boolean;
}

const toUpdate = ({ name, oldOid, newOid, kind, forced }: Command): ReceiveUpdate => ({
  name,
  oldOid,
  newOid,
  kind,
  forced,
});

/** Reads the ref commands. Null when the client sent none (it only wanted the refs). */
async function readCommands(
  ctx: Context,
): Promise<{ commands: Command[]; capabilities: Set<string> } | null> {
  const commands: Command[] = [];
  let capabilities = new Set<string>();
  for (;;) {
    const pkt = await ctx.reader.read();
    if (pkt === null) return null;
    if (pkt.type === "flush") break;
    if (pkt.type !== "data") throw new ProtocolError("receive-pack: unexpected packet");
    let line = lineOf(pkt.data);
    if (commands.length === 0 && capabilities.size === 0) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        capabilities = parseCapabilities(line.slice(nul + 1));
        line = line.slice(0, nul);
      }
    }
    // A shallow client says where its history stops. Nothing here depends on
    // it: the pack is checked against what the repository really has.
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) {
      throw new ProtocolError("receive-pack: signed pushes are not supported");
    }
    const oldOid = parseOid(line.slice(0, 40), "a ref update");
    const newOid = parseOid(line.slice(41, 81), "a ref update");
    const name = line.slice(82);
    if (line[40] !== " " || line[81] !== " " || name === "") {
      throw new ProtocolError("receive-pack: malformed ref update");
    }
    if (commands.length >= ctx.limits.maxRefUpdates) {
      throw new ProtocolError("receive-pack: too many ref updates");
    }
    commands.push({
      name,
      oldOid,
      newOid,
      error: null,
      kind: oldOid === ZERO_OID ? "create" : newOid === ZERO_OID ? "delete" : "update",
      forced: false,
    });
  }
  return commands.length === 0 ? null : { commands, capabilities };
}

/** What can be said about a command before policy and the ref store see it. */
async function validate(
  command: Command,
  reader: ObjectReader,
  graph: CommitGraph,
  head: string | null,
  seen: Set<string>,
): Promise<string | null> {
  if (seen.has(command.name)) return "ref updated more than once in one push";
  seen.add(command.name);
  if (!command.name.startsWith("refs/") || !isValidRefName(command.name)) return "funny refname";
  if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) return "nothing to do";
  if (command.kind === "delete") {
    return command.name === head ? "deletion of the current branch prohibited" : null;
  }
  const isBranch = command.name.startsWith("refs/heads/");
  const commit = await graph.get(command.newOid);
  if (!commit) {
    if (!(await reader.has(command.newOid))) return "missing necessary objects";
    if (isBranch) return "a branch can only point at a commit";
  }
  if (command.kind === "update") {
    command.forced = !(commit && (await isAncestor(graph, command.oldOid, command.newOid)));
  }
  return null;
}

export async function* receivePack(ctx: Context): AsyncGenerator<Uint8Array, void, void> {
  const { backend, request: serve } = ctx;
  const listing = await listRefs(backend);
  if (!serve.statelessRpc || serve.advertiseOnly) {
    const capabilities = [...CAPABILITIES, "object-format=sha1", `agent=${ctx.agent}`].join(" ");
    // No HEAD line: a push names refs, and git's own receive-pack lists none either.
    yield advertiseRefsV0(ctx, { ...listing, headOid: null }, capabilities);
  }
  if (serve.advertiseOnly) return;

  const read = await readCommands(ctx);
  if (!read) return;
  const { commands, capabilities } = read;
  const sideBand = capabilities.has("side-band-64k") ? SIDE_BAND_64K_MAX_LENGTH : 0;
  ctx.errorBand = sideBand;

  const pushOptions: string[] = [];
  if (capabilities.has("push-options")) {
    for (;;) {
      const pkt = await ctx.reader.read();
      if (pkt === null || pkt.type !== "data") break;
      if (pushOptions.length < 64) pushOptions.push(lineOf(pkt.data));
    }
  }

  let ingested: IngestedPack | null = null;
  let unpackError: string | null = null;
  if (commands.some((command) => command.kind !== "delete")) {
    try {
      ingested = await backend.ingestPack(ctx.reader.restStream());
      ctx.stats.objectsReceived += ingested.objectCount;
      ctx.stats.packBytesReceived += ingested.size;
    } catch (error) {
      // A pack the storage refused is the client's to hear about; anything else is ours.
      if (!(error instanceof GitError)) throw error;
      unpackError = error.message;
    }
  }

  const applied: ReceiveUpdate[] = [];
  if (unpackError !== null) {
    for (const command of commands) command.error = "unpacker error";
  } else {
    const reader = ingested?.reader ?? backend;
    const graph = new CommitGraph(reader);
    const seen = new Set<string>();
    for (const command of commands) {
      command.error = await validate(command, reader, graph, listing.head, seen);
    }
    const candidates = commands.filter((command) => command.error === null);
    if (ctx.hooks && candidates.length > 0) {
      const refused = await ctx.hooks.check(candidates.map(toUpdate), { pushOptions });
      for (const command of candidates) command.error = refused.get(command.name) ?? null;
    }
    const atomic = capabilities.has("atomic");
    if (atomic && commands.some((command) => command.error !== null)) {
      for (const command of commands) command.error ??= "atomic push failure";
    }
    const ready = commands.filter((command) => command.error === null);
    if (ready.length > 0) {
      const results = await backend.updateRefs(ready, { atomic, pack: ingested });
      const errors = new Map(results.map((result) => [result.name, result.error]));
      for (const command of ready) {
        command.error = errors.get(command.name) ?? null;
        if (command.error === null) applied.push(toUpdate(command));
      }
    } else if (ingested) {
      await backend.discardPack(ingested);
    }
    ctx.stats.refsUpdated += applied.length;
    if (ctx.hooks && applied.length > 0) {
      // The refs have moved whatever happens here; a failed notification must not fail the push.
      await ctx.hooks.after(applied).catch(() => undefined);
    }
  }

  if (!capabilities.has("report-status") && !capabilities.has("report-status-v2")) return;
  const report = concatBytes([
    encodePktLine(`unpack ${unpackError ?? "ok"}\n`),
    ...commands.map((command) =>
      encodePktLine(
        command.error === null ? `ok ${command.name}\n` : `ng ${command.name} ${command.error}\n`,
      ),
    ),
    FLUSH_PKT,
  ]);
  if (sideBand === 0) {
    yield report;
    return;
  }
  const out: Uint8Array[] = [];
  if (unpackError !== null && !capabilities.has("quiet")) {
    out.push(...encodeSideBand(SIDE_BAND_PROGRESS, `error: ${unpackError}\n`, sideBand));
  }
  out.push(...encodeSideBand(SIDE_BAND_DATA, report, sideBand), FLUSH_PKT);
  yield concatBytes(out);
}
