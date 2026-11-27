/**
 * What a fetch amounts to once the wire format is out of the way: checking
 * the wants, working out the shallow boundary, choosing the objects and
 * producing the pack. Protocol v0/v1 and v2 both end up here.
 */
import {
  type ObjectId,
  type PackInput,
  type Ref,
  SIDE_BAND_DATA,
  SIDE_BAND_PROGRESS,
  concatBytes,
  encodeSideBand,
  encodeSideBandRun,
  iterateBytes,
  writePack,
} from "@infrawrench/git-core";
import { type Context, ProtocolError, type RefListing } from "./common";
import { OidSet } from "./oid-set";
import {
  CommitGraph,
  ancestorsOf,
  peelWant,
  reachableAmong,
  selectCommits,
  selectObjects,
  shallowByDepth,
  shallowEdges,
  shallowByRule,
} from "./walk";

/** `--unshallow` asks for this depth (`INFINITE_DEPTH` in git). */
const INFINITE_DEPTH = 0x7fffffff;

export interface FetchRequest {
  wants: ObjectId[];
  /** Every `have` the client sent this round, whether or not the repository has it. */
  haves: ObjectId[];
  /** The client's own shallow commits. */
  clientShallow: ObjectId[];
  depth: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  deepenNot: string[];
  thinPack: boolean;
  ofsDelta: boolean;
  includeTag: boolean;
  noProgress: boolean;
  /** The largest side-band packet, or 0 when the pack goes out bare. */
  sideBand: number;
  done: boolean;
}

export function emptyFetchRequest(): FetchRequest {
  return {
    wants: [],
    haves: [],
    clientShallow: [],
    depth: null,
    deepenRelative: false,
    deepenSince: null,
    deepenNot: [],
    thinPack: false,
    ofsDelta: false,
    includeTag: false,
    noProgress: false,
    sideBand: 0,
    done: false,
  };
}

export const wantsShallowInfo = (request: FetchRequest): boolean =>
  request.depth !== null ||
  request.deepenSince !== null ||
  request.deepenNot.length > 0 ||
  request.clientShallow.length > 0;

export const deepens = (request: FetchRequest): boolean =>
  request.depth !== null || request.deepenSince !== null || request.deepenNot.length > 0;

export interface ResolvedWants {
  /** Commits the wants lead to. */
  readonly commits: ObjectId[];
  readonly tags: ObjectId[];
  readonly trees: ObjectId[];
  readonly blobs: ObjectId[];
}

/**
 * Checks that each want is something the client may ask for and sorts them
 * by kind. A ref's tip (or what its tag peels to) is always allowed; any
 * other id must be a commit reachable from a ref, which is what lets a CI
 * runner fetch the exact commit of a run after the branch has moved on.
 */
export async function resolveWants(
  graph: CommitGraph,
  listing: RefListing,
  wants: readonly ObjectId[],
): Promise<ResolvedWants> {
  const tips = new Set<ObjectId>();
  for (const ref of listing.refs) {
    tips.add(ref.oid);
    if (ref.peeled) tips.add(ref.peeled);
  }
  const resolved = { commits: [], tags: [], trees: [], blobs: [] } as {
    commits: ObjectId[];
    tags: ObjectId[];
    trees: ObjectId[];
    blobs: ObjectId[];
  };
  const notTips: ObjectId[] = [];
  for (const want of new Set(wants)) {
    const peeled = await peelWant(graph.reader, want);
    if (!peeled) throw new ProtocolError(`upload-pack: not our ref ${want}`);
    if (!tips.has(want)) {
      if (peeled.type !== "commit" || peeled.tags.length > 0) {
        throw new ProtocolError(`upload-pack: not our ref ${want}`);
      }
      notTips.push(want);
    }
    resolved.tags.push(...peeled.tags);
    if (peeled.type === "commit") resolved.commits.push(peeled.oid);
    else if (peeled.type === "tree") resolved.trees.push(peeled.oid);
    else resolved.blobs.push(peeled.oid);
  }
  if (notTips.length > 0) {
    // One walk for all of them: a request may name thousands.
    const reachable = await reachableAmong(graph, [...tips], notTips);
    const stray = notTips.find((want) => !reachable.has(want));
    if (stray !== undefined) throw new ProtocolError(`upload-pack: not our ref ${stray}`);
  }
  return resolved;
}

export interface ShallowPlan {
  /** Commits whose parents are not sent. */
  readonly wantStops: Set<ObjectId>;
  readonly shallow: ObjectId[];
  /** The client's shallow commits that stop being shallow: their parents are sent now. */
  readonly unshallow: ObjectId[];
}

/** Where the history sent to this client stops, and what to tell it about its shallow file. */
export async function planShallow(
  graph: CommitGraph,
  listing: RefListing,
  request: FetchRequest,
  wantCommits: readonly ObjectId[],
): Promise<ShallowPlan> {
  const clientShallow = new Set(request.clientShallow);
  if (!deepens(request)) {
    // An ordinary fetch into a shallow clone: its history stays cut where it is.
    return { wantStops: clientShallow, shallow: [], unshallow: [] };
  }
  // A shallow line is the client's word that it has a commit. Deepening
  // sends what lies below one, so only those the wants reach count: any
  // other id the repository happens to hold (what a forced push left, a
  // commit copied in from another repository) would otherwise have its
  // history sent to whoever names it.
  const ours =
    clientShallow.size === 0
      ? new Set<ObjectId>()
      : await reachableAmong(graph, wantCommits, [...clientShallow]);
  if (request.depth !== null && request.depth >= INFINITE_DEPTH) {
    return { wantStops: new Set(), shallow: [], unshallow: [...ours] };
  }
  let cut;
  if (request.depth !== null) {
    const known: ObjectId[] = request.deepenRelative ? [...ours] : [];
    // `deepen-relative` counts from the client's current boundary, which is itself at depth 1.
    cut =
      known.length > 0
        ? await shallowByDepth(graph, known, request.depth + 1)
        : await shallowByDepth(graph, wantCommits, request.depth);
    if (known.length > 0) {
      // Wants above the old boundary are part of the history too.
      const above = await shallowByRule(graph, wantCommits, null, cut.included);
      for (const oid of above.included) cut.included.add(oid);
    }
  } else {
    const tips: ObjectId[] = [];
    for (const name of request.deepenNot) {
      const ref = findRef(listing.refs, name);
      if (!ref) throw new ProtocolError(`upload-pack: deepen-not is not a ref: ${name}`);
      tips.push(ref.peeled ?? ref.oid);
    }
    const excluded = tips.length > 0 ? await ancestorsOf(graph, tips) : new Set<ObjectId>();
    cut = await shallowByRule(graph, wantCommits, request.deepenSince, excluded);
    if (cut.included.size === 0) {
      throw new ProtocolError("upload-pack: no commits selected for shallow requests");
    }
  }
  const shallow = [...cut.boundary].filter((oid) => !clientShallow.has(oid));
  const unshallow = [...ours].filter((oid) => cut.included.has(oid) && !cut.boundary.has(oid));
  return { wantStops: cut.boundary, shallow, unshallow };
}

/** `deepen-not` takes a ref the way a person writes one: `main`, `v1`, or the full name. */
function findRef(refs: readonly Ref[], name: string): Ref | undefined {
  for (const candidate of [name, `refs/tags/${name}`, `refs/heads/${name}`]) {
    const ref = refs.find((each) => each.name === candidate);
    if (ref) return ref;
  }
  return undefined;
}

export interface FetchPlan {
  readonly wants: ResolvedWants;
  readonly shallow: ShallowPlan;
}

export interface PackOutput {
  readonly stream: ReadableStream<Uint8Array>;
  readonly objectCount: number;
}

/** Chooses the objects for a fetch and starts the pack. `common` are the haves the repository has. */
export async function buildPack(
  ctx: Context,
  graph: CommitGraph,
  listing: RefListing,
  request: FetchRequest,
  plan: FetchPlan,
  common: readonly ObjectId[],
  onProgress: (text: string) => void,
): Promise<PackOutput> {
  const { backend } = ctx;
  const started = Date.now();
  const pack = await choosePack(ctx, graph, listing, request, plan, common, onProgress);
  ctx.stats.selectMillis += Date.now() - started;
  return pack;
}

async function choosePack(
  ctx: Context,
  graph: CommitGraph,
  listing: RefListing,
  request: FetchRequest,
  plan: FetchPlan,
  common: readonly ObjectId[],
  onProgress: (text: string) => void,
): Promise<PackOutput> {
  const { backend } = ctx;
  const whole = common.length === 0 && request.clientShallow.length === 0 && !deepens(request);
  if (whole && backend.packEverything) {
    // A clone: everything, provided the client asked for every branch and tag.
    const wanted = new Set(request.wants);
    const tips = listing.refs.filter(
      (ref) => ref.name.startsWith("refs/heads/") || ref.name.startsWith("refs/tags/"),
    );
    if (tips.length > 0 && tips.every((ref) => wanted.has(ref.oid))) {
      const everything = await backend.packEverything({ ofsDelta: request.ofsDelta });
      if (everything) {
        ctx.stats.packSource = "everything";
        onProgress(`Sending ${everything.objectCount} objects\n`);
        return everything;
      }
    }
  }

  const commits = await selectCommits(
    graph,
    plan.wants.commits,
    common,
    plan.shallow.wantStops,
    new Set(request.clientShallow),
    new Set(plan.shallow.unshallow),
  );
  // A shallow client's history is cut, so what it has is not found by walking down to it.
  const edges = wantsShallowInfo(request)
    ? await shallowEdges(graph, commits.edges, common)
    : commits.edges;
  const selection = await selectObjects(graph, {
    commits: commits.commits,
    edges,
    tags: plan.wants.tags,
    trees: plan.wants.trees,
    blobs: plan.wants.blobs,
    onProgress: (count) => onProgress(`Enumerating objects: ${count}\r`),
  });
  const objects = selection.objects;
  if (request.includeTag) {
    // A tag whose commit is going out goes with it, so the client need not ask again.
    for (const ref of listing.refs) {
      if (ref.peeled === undefined || objects.has(ref.oid)) continue;
      if (!objects.has(ref.peeled)) continue;
      const chain = await peelWant(backend, ref.oid);
      for (const tag of chain?.tags ?? []) objects.add(tag);
    }
  }
  onProgress(`Enumerating objects: ${objects.size}, done.\n`);

  if (backend.packObjects) {
    ctx.stats.packSource = "objects";
    return {
      stream: backend.packObjects({
        objects,
        thinBases: request.thinPack ? selection.have : null,
        ofsDelta: request.ofsDelta,
      }),
      objectCount: objects.size,
    };
  }
  ctx.stats.packSource = "rebuilt";
  return { stream: rebuildPack(ctx, objects), objectCount: objects.size };
}

/** The slow path: every object read whole and compressed again. */
function rebuildPack(ctx: Context, objects: OidSet): ReadableStream<Uint8Array> {
  async function* inputs(): AsyncGenerator<PackInput, void, void> {
    for (const oid of objects) {
      const object = await ctx.backend.read(oid);
      if (!object) throw new ProtocolError(`upload-pack: object ${oid} is missing`);
      yield { type: object.type, data: object.data };
    }
  }
  return writePack(inputs(), { count: objects.size });
}

/** Frames a pack for the wire: bare, or as side-band data with the progress text beside it. */
export async function* sendPack(
  ctx: Context,
  pack: PackOutput,
  sideBand: number,
  pendingProgress: string[],
): AsyncGenerator<Uint8Array, void, void> {
  const progress = (): Uint8Array[] =>
    sideBand === 0
      ? []
      : pendingProgress
          .splice(0)
          .flatMap((text) => encodeSideBand(SIDE_BAND_PROGRESS, text, sideBand));
  const before = progress();
  if (before.length > 0) yield concatBytes(before);
  let bytes = 0;
  const started = Date.now();
  if (sideBand === 0) {
    for await (const chunk of iterateBytes(pack.stream)) {
      bytes += chunk.length;
      yield chunk;
    }
  } else {
    // Whole packets wherever possible: storage hands the pack over in pieces
    // of its own size, and a packet per small piece is five bytes of framing
    // and a write each.
    const room = sideBand - 5;
    let held: Uint8Array[] = [];
    let heldBytes = 0;
    for await (const chunk of iterateBytes(pack.stream)) {
      bytes += chunk.length;
      held.push(chunk);
      heldBytes += chunk.length;
      if (heldBytes < room) continue;
      const whole = heldBytes - (heldBytes % room);
      yield encodeSideBandRun(SIDE_BAND_DATA, held, whole, sideBand);
      // What did not fill a packet is the end of the last piece: less than a packet of it.
      const last = held[held.length - 1]!;
      const rest = heldBytes - whole;
      held = rest > 0 ? [last.subarray(last.length - rest)] : [];
      heldBytes = rest;
    }
    if (heldBytes > 0) yield encodeSideBandRun(SIDE_BAND_DATA, held, heldBytes, sideBand);
  }
  ctx.stats.objectsSent += pack.objectCount;
  ctx.stats.packBytesSent += bytes;
  ctx.stats.packMillis += Date.now() - started;
  pendingProgress.push(
    `Total ${pack.objectCount} (delta 0), reused ${pack.objectCount} (delta 0)\n`,
  );
  const after = progress();
  if (after.length > 0) yield concatBytes(after);
}
