/**
 * `git-upload-pack`: the server side of clone and fetch, in the classic
 * protocol (v0, and v1 which is v0 with a version line) and in protocol v2.
 */
import {
  type ObjectId,
  type Pkt,
  SIDE_BAND_64K_MAX_LENGTH,
  SIDE_BAND_MAX_LENGTH,
  ZERO_OID,
  concatBytes,
  encodePktLine,
  FLUSH_PKT,
  DELIM_PKT,
} from "@infrawrench/git-core";
import {
  type Context,
  ProtocolError,
  type RefListing,
  lineOf,
  listRefs,
  parseCapabilities,
  parseOid,
} from "./common";
import {
  type FetchPlan,
  type FetchRequest,
  buildPack,
  deepens,
  emptyFetchRequest,
  planShallow,
  resolveWants,
  sendPack,
  wantsShallowInfo,
} from "./fetch";
import { CommitGraph, wantsCovered } from "./walk";

/**
 * `filter` is left out until partial clone is implemented: a client that
 * saw it would send filters this server ignores.
 */
const V0_CAPABILITIES = [
  "multi_ack_detailed",
  "side-band",
  "side-band-64k",
  "thin-pack",
  "ofs-delta",
  "shallow",
  "deepen-since",
  "deepen-not",
  "deepen-relative",
  "no-progress",
  "include-tag",
  "allow-tip-sha1-in-want",
  "allow-reachable-sha1-in-want",
];

function capabilityLine(ctx: Context, listing: RefListing): string {
  const words = [...V0_CAPABILITIES];
  if (listing.head !== null) words.push(`symref=HEAD:${listing.head}`);
  words.push("object-format=sha1", `agent=${ctx.agent}`);
  return words.join(" ");
}

/** The classic ref advertisement: every ref, capabilities after a NUL on the first line. */
export function advertiseRefsV0(
  ctx: Context,
  listing: RefListing,
  capabilities: string,
): Uint8Array {
  const lines: string[] = [];
  if (listing.headOid !== null) lines.push(`${listing.headOid} HEAD`);
  for (const ref of listing.refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  // An empty repository still has to say what it can do.
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  const out: Uint8Array[] = [];
  if (ctx.request.version === 1) out.push(encodePktLine("version 1\n"));
  lines.forEach((line, index) => {
    out.push(encodePktLine(index === 0 ? `${line}\0${capabilities}\n` : `${line}\n`));
  });
  out.push(FLUSH_PKT);
  return concatBytes(out);
}

function parseDepth(text: string): number {
  const depth = Number(text);
  if (!Number.isInteger(depth) || depth <= 0) {
    throw new ProtocolError(`upload-pack: invalid deepen: ${text}`);
  }
  return depth;
}

function parseSince(text: string): number {
  const since = Number(text);
  if (!Number.isFinite(since) || since < 0) {
    throw new ProtocolError(`upload-pack: invalid deepen-since: ${text}`);
  }
  return since;
}

/** A `want` line's id, counted against the limit as it is read rather than after. */
function addWant(ctx: Context, request: FetchRequest, text: string): void {
  if (request.wants.length >= ctx.limits.maxWants) {
    throw new ProtocolError("upload-pack: too many wants");
  }
  request.wants.push(parseOid(text, "want"));
}

/** A line both protocols share: `shallow`, `deepen`, `deepen-since`, `deepen-not`. */
function parseShallowLine(ctx: Context, line: string, request: FetchRequest): boolean {
  if (line.startsWith("shallow ")) {
    if (request.clientShallow.length >= ctx.limits.maxShallows) {
      throw new ProtocolError("upload-pack: too many shallow lines");
    }
    request.clientShallow.push(parseOid(line.slice(8), "shallow"));
  } else if (line.startsWith("deepen-since ")) {
    request.deepenSince = parseSince(line.slice(13));
  } else if (line.startsWith("deepen-not ")) {
    if (request.deepenNot.length >= ctx.limits.maxDeepenNots) {
      throw new ProtocolError("upload-pack: too many deepen-not lines");
    }
    request.deepenNot.push(line.slice(11));
  } else if (line.startsWith("deepen ")) {
    request.depth = parseDepth(line.slice(7));
  } else {
    return false;
  }
  if (request.depth !== null && (request.deepenSince !== null || request.deepenNot.length > 0)) {
    throw new ProtocolError(
      "upload-pack: deepen and deepen-since (or deepen-not) cannot be used together",
    );
  }
  return true;
}

/** Everything a fetch needs once its wants are known. */
async function prepare(
  ctx: Context,
  listing: RefListing,
  request: FetchRequest,
): Promise<{ graph: CommitGraph; plan: FetchPlan }> {
  if (request.wants.length > ctx.limits.maxWants) {
    throw new ProtocolError("upload-pack: too many wants");
  }
  const graph = new CommitGraph(ctx.backend);
  const wants = await resolveWants(graph, listing, request.wants);
  const shallow = await planShallow(graph, listing, request, wants.commits);
  return { graph, plan: { wants, shallow } };
}

/**
 * `wantsCovered` within this round's budget and what is left of the
 * conversation's. A conversation that has spent it all is answered ready at
 * once: more rounds could only make the pack smaller, and over SSH a client
 * could otherwise keep the object walking for as long as it liked.
 */
async function covered(
  ctx: Context,
  graph: CommitGraph,
  wants: readonly ObjectId[],
  common: ReadonlySet<ObjectId>,
): Promise<boolean> {
  const budget = { left: Math.min(ctx.limits.maxNegotiationCommits, ctx.negotiationLeft) };
  if (budget.left <= 0) return true;
  const start = budget.left;
  try {
    return await wantsCovered(graph, wants, common, budget);
  } finally {
    ctx.negotiationLeft -= start - Math.max(budget.left, 0);
  }
}

function shallowLines(plan: FetchPlan): Uint8Array[] {
  return [
    ...plan.shallow.shallow.map((oid) => encodePktLine(`shallow ${oid}\n`)),
    ...plan.shallow.unshallow.map((oid) => encodePktLine(`unshallow ${oid}\n`)),
  ];
}

/** Reads the wants of a classic request. Null when the client asked for nothing. */
async function readWantsV0(
  ctx: Context,
): Promise<{ request: FetchRequest; multiAck: 0 | 2 } | null> {
  const request = emptyFetchRequest();
  let multiAck: 0 | 2 = 0;
  let first = true;
  for (;;) {
    const pkt = await ctx.reader.read();
    if (pkt === null) return null;
    if (pkt.type !== "data") {
      if (pkt.type === "flush") break;
      throw new ProtocolError("upload-pack: unexpected packet in the request");
    }
    const line = lineOf(pkt.data);
    if (line.startsWith("want ")) {
      addWant(ctx, request, line.slice(5, 45));
      if (first) {
        first = false;
        const caps = parseCapabilities(line.slice(45));
        if (caps.has("multi_ack_detailed")) multiAck = 2;
        request.thinPack = caps.has("thin-pack");
        request.ofsDelta = caps.has("ofs-delta");
        request.includeTag = caps.has("include-tag");
        request.noProgress = caps.has("no-progress");
        request.deepenRelative = caps.has("deepen-relative");
        if (caps.has("side-band-64k")) request.sideBand = SIDE_BAND_64K_MAX_LENGTH;
        else if (caps.has("side-band")) request.sideBand = SIDE_BAND_MAX_LENGTH;
        if (caps.has("filter")) throw new ProtocolError("upload-pack: filter is not supported");
      }
    } else if (!parseShallowLine(ctx, line, request)) {
      throw new ProtocolError(`upload-pack: expected want, got '${line.slice(0, 40)}'`);
    }
  }
  return request.wants.length === 0 ? null : { request, multiAck };
}

export async function* uploadPackV0(ctx: Context): AsyncGenerator<Uint8Array, void, void> {
  const { request: serve } = ctx;
  let listing = await listRefs(ctx.backend);
  if (!serve.statelessRpc || serve.advertiseOnly) {
    yield advertiseRefsV0(ctx, listing, capabilityLine(ctx, listing));
  }
  if (serve.advertiseOnly) return;

  const wanted = await readWantsV0(ctx);
  if (!wanted) return;
  const { request, multiAck } = wanted;
  const { graph, plan } = await prepare(ctx, listing, request);
  if (deepens(request)) {
    yield concatBytes([...shallowLines(plan), FLUSH_PKT]);
  }

  // Negotiation: the client lists commits it has until the server knows enough.
  const common: ObjectId[] = [];
  const commonSet = new Set<ObjectId>();
  let haves = 0;
  let sentReady = false;
  let out: Uint8Array[] = [];
  for (;;) {
    const pkt: Pkt | null = await ctx.reader.read();
    // The client left, or a stateless request ended without `done`.
    if (pkt === null) {
      if (out.length > 0) yield concatBytes(out);
      return;
    }
    if (pkt.type === "flush") {
      if (
        multiAck === 2 &&
        !sentReady &&
        common.length > 0 &&
        (await covered(ctx, graph, plan.wants.commits, commonSet))
      ) {
        out.push(encodePktLine(`ACK ${common[common.length - 1]} ready\n`));
        sentReady = true;
      }
      if (common.length === 0 || multiAck !== 0) out.push(encodePktLine("NAK\n"));
      yield concatBytes(out);
      out = [];
      if (serve.statelessRpc) return;
      continue;
    }
    if (pkt.type !== "data") throw new ProtocolError("upload-pack: unexpected packet");
    const line = lineOf(pkt.data);
    if (line === "done") {
      if (common.length > 0) {
        if (multiAck !== 0) out.push(encodePktLine(`ACK ${common[common.length - 1]}\n`));
      } else {
        out.push(encodePktLine("NAK\n"));
      }
      break;
    }
    if (!line.startsWith("have ")) {
      throw new ProtocolError(`upload-pack: expected have, got '${line.slice(0, 40)}'`);
    }
    if (++haves > ctx.limits.maxHaves) throw new ProtocolError("upload-pack: too many haves");
    const oid = parseOid(line.slice(5), "have");
    if (commonSet.has(oid) || !(await graph.get(oid))) continue;
    commonSet.add(oid);
    common.push(oid);
    if (multiAck === 2) out.push(encodePktLine(`ACK ${oid} common\n`));
    else if (common.length === 1) out.push(encodePktLine(`ACK ${oid}\n`));
  }
  if (out.length > 0) yield concatBytes(out);

  // A stateful connection listed the refs a while ago; what is sent is still what was asked for.
  listing = serve.statelessRpc ? listing : await listRefs(ctx.backend);
  const progress: string[] = [];
  const pack = await buildPack(ctx, graph, listing, request, plan, common, (text) => {
    if (!request.noProgress) progress.push(text);
  });
  ctx.errorBand = request.sideBand;
  yield* sendPack(ctx, pack, request.sideBand, request.noProgress ? [] : progress);
  if (request.sideBand !== 0) yield FLUSH_PKT;
}

/** Protocol v2's opening: what the server can do, with no refs. */
export function advertiseCapabilitiesV2(ctx: Context): Uint8Array {
  return concatBytes([
    encodePktLine("version 2\n"),
    encodePktLine(`agent=${ctx.agent}\n`),
    encodePktLine("ls-refs=unborn\n"),
    encodePktLine("fetch=shallow\n"),
    encodePktLine("server-option\n"),
    encodePktLine("object-format=sha1\n"),
    FLUSH_PKT,
  ]);
}

async function* lsRefs(
  ctx: Context,
  args: readonly string[],
): AsyncGenerator<Uint8Array, void, void> {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === "peel") peel = true;
    else if (arg === "symrefs") symrefs = true;
    else if (arg === "unborn") unborn = true;
    else if (arg.startsWith("ref-prefix ")) prefixes.push(arg.slice(11));
    else throw new ProtocolError(`ls-refs: unexpected argument '${arg.slice(0, 40)}'`);
  }
  // Each prefix is tried against each ref; past the limit, list everything and let the client filter.
  if (prefixes.length > ctx.limits.maxRefPrefixes) prefixes.length = 0;
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const listing = await listRefs(ctx.backend);
  const out: Uint8Array[] = [];
  if (matches("HEAD") && listing.head !== null) {
    const target = symrefs ? ` symref-target:${listing.head}` : "";
    if (listing.headOid !== null) out.push(encodePktLine(`${listing.headOid} HEAD${target}\n`));
    else if (unborn) out.push(encodePktLine(`unborn HEAD${target}\n`));
  }
  for (const ref of listing.refs) {
    if (!matches(ref.name)) continue;
    const peeled = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : "";
    out.push(encodePktLine(`${ref.oid} ${ref.name}${peeled}\n`));
  }
  out.push(FLUSH_PKT);
  yield concatBytes(out);
}

async function* fetchV2(
  ctx: Context,
  args: readonly string[],
): AsyncGenerator<Uint8Array, void, void> {
  const request = emptyFetchRequest();
  request.sideBand = SIDE_BAND_64K_MAX_LENGTH;
  for (const arg of args) {
    if (arg.startsWith("want ")) addWant(ctx, request, arg.slice(5));
    else if (arg.startsWith("have ")) {
      if (request.haves.length >= ctx.limits.maxHaves) {
        throw new ProtocolError("fetch: too many haves");
      }
      request.haves.push(parseOid(arg.slice(5), "have"));
    } else if (arg === "done") request.done = true;
    else if (arg === "thin-pack") request.thinPack = true;
    else if (arg === "ofs-delta") request.ofsDelta = true;
    else if (arg === "no-progress") request.noProgress = true;
    else if (arg === "include-tag") request.includeTag = true;
    else if (arg === "deepen-relative") request.deepenRelative = true;
    else if (parseShallowLine(ctx, arg, request)) continue;
    else throw new ProtocolError(`fetch: unexpected argument '${arg.slice(0, 40)}'`);
  }
  if (request.wants.length === 0) {
    // Nothing wanted is not an error: the client is only closing the round.
    yield FLUSH_PKT;
    return;
  }
  const listing = await listRefs(ctx.backend);
  const { graph, plan } = await prepare(ctx, listing, request);

  const common: ObjectId[] = [];
  const commonSet = new Set<ObjectId>();
  for (const oid of request.haves) {
    if (!commonSet.has(oid) && (await graph.get(oid))) {
      commonSet.add(oid);
      common.push(oid);
    }
  }
  const out: Uint8Array[] = [];
  if (!request.done) {
    out.push(encodePktLine("acknowledgments\n"));
    if (common.length === 0) out.push(encodePktLine("NAK\n"));
    for (const oid of common) out.push(encodePktLine(`ACK ${oid}\n`));
    const ready = await covered(ctx, graph, plan.wants.commits, commonSet);
    if (!ready) {
      out.push(FLUSH_PKT);
      yield concatBytes(out);
      return;
    }
    out.push(encodePktLine("ready\n"), DELIM_PKT);
  }
  if (wantsShallowInfo(request)) {
    out.push(encodePktLine("shallow-info\n"), ...shallowLines(plan), DELIM_PKT);
  }
  out.push(encodePktLine("packfile\n"));
  yield concatBytes(out);

  const progress: string[] = [];
  const pack = await buildPack(ctx, graph, listing, request, plan, common, (text) => {
    if (!request.noProgress) progress.push(text);
  });
  ctx.errorBand = request.sideBand;
  yield* sendPack(ctx, pack, request.sideBand, request.noProgress ? [] : progress);
  yield FLUSH_PKT;
}

export async function* uploadPackV2(ctx: Context): AsyncGenerator<Uint8Array, void, void> {
  const { request: serve } = ctx;
  if (!serve.statelessRpc || serve.advertiseOnly) yield advertiseCapabilitiesV2(ctx);
  if (serve.advertiseOnly) return;
  for (let commands = 1; ; commands++) {
    const first = await ctx.reader.read();
    // A flush where a command would start is the client saying goodbye.
    if (first === null || first.type !== "data") return;
    if (commands > ctx.limits.maxCommands) throw new ProtocolError("too many commands");
    const command = lineOf(first.data);
    if (!command.startsWith("command=")) {
      throw new ProtocolError(`expected a command, got '${command.slice(0, 40)}'`);
    }
    const args: string[] = [];
    // The arguments are all read before any is looked at, so they are bounded here, in bytes.
    let argBytes = 0;
    let inArgs = false;
    for (;;) {
      const pkt = await ctx.reader.read();
      if (pkt === null || pkt.type === "flush") break;
      if (pkt.type === "delim") {
        inArgs = true;
        continue;
      }
      if (pkt.type !== "data") throw new ProtocolError("unexpected packet in a command");
      const line = lineOf(pkt.data);
      if (inArgs) {
        argBytes += pkt.data.length;
        if (argBytes > ctx.limits.maxArgumentBytes) {
          throw new ProtocolError("too many arguments to one command");
        }
        args.push(line);
      } else if (line.startsWith("object-format=") && line !== "object-format=sha1") {
        throw new ProtocolError(`unsupported object format '${line.slice(14)}'`);
      }
    }
    ctx.errorBand = 0;
    if (command === "command=ls-refs") yield* lsRefs(ctx, args);
    else if (command === "command=fetch") yield* fetchV2(ctx, args);
    else throw new ProtocolError(`unknown command '${command.slice(8, 48)}'`);
    if (serve.statelessRpc) return;
  }
}
