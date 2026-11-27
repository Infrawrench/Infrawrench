/**
 * The client half of a push over smart HTTP: what `git send-pack` does
 * against a remote's `git-receive-pack`. A push mirror uses it to keep
 * another host equal to a repository here.
 *
 * Two requests, as git makes them:
 *
 * 1. `GET <url>/info/refs?service=git-receive-pack` answers the remote's
 *    refs and what its receive-pack can do ({@link parseReceiveAdvertisement}).
 * 2. `POST <url>/git-receive-pack` carries the ref commands, each with the
 *    value the advertisement showed (so the remote refuses an update whose
 *    ref moved in between), then the pack ({@link encodeSendPackCommands}),
 *    and answers a status for the pack and for each ref
 *    ({@link readSendPackReport}).
 *
 * This module knows the wire and nothing else. Which refs to send, which
 * objects the pack holds, the remote's address and its credential are the
 * caller's: it is handed a `fetch`, and puts nothing of a request or an
 * answer into an error but a status code and what the remote said about a
 * ref.
 */
import {
  type ByteSource,
  FLUSH_PKT,
  GitError,
  type ObjectId,
  PktLineReader,
  ZERO_OID,
  concatBytes,
  decodeText,
  demuxSideBand,
  encodePktLine,
  isObjectId,
  isValidRefName,
  iterateBytes,
  streamFrom,
} from "@infrawrench/git-core";
import { DEFAULT_AGENT, parseCapabilities } from "./common";

/** What a remote's `git-receive-pack` says before a push. */
export interface ReceiveAdvertisement {
  /** Every ref the remote showed, by full name. */
  readonly refs: ReadonlyMap<string, ObjectId>;
  /** Objects the remote has that no ref of its own names (`.have`, from an alternate). */
  readonly extraHaves: readonly ObjectId[];
  readonly capabilities: ReadonlySet<string>;
}

/** One ref change. `oldOid` is what the remote showed (zeros to create), `newOid` zeros to delete. */
export interface SendPackCommand {
  readonly name: string;
  readonly oldOid: ObjectId;
  readonly newOid: ObjectId;
}

/** The remote's answer to a push. */
export interface SendPackReport {
  /** Null when the pack was taken; otherwise what the remote said went wrong with it. */
  readonly unpackError: string | null;
  /** Each ref the remote answered for: null when it moved, otherwise why it was refused. */
  readonly refs: ReadonlyMap<string, string | null>;
}

/** Why a request to the remote failed, in a form that is safe to store and show. */
export class SendPackError extends Error {
  override readonly name = "SendPackError";
  constructor(
    readonly code:
      "unauthorized" | "forbidden" | "not-found" | "redirected" | "not-git" | "bad-answer" | "http",
    message: string,
    /** The HTTP status, when the remote answered with one. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** The most bytes of advertisement that are read: about half a million refs. */
export const MAX_ADVERTISEMENT_BYTES = 32 * 1024 * 1024;
/** The most bytes of a push's answer that are read. Progress text is thrown away as it comes. */
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
/** A remote's reason for refusing a ref is cut to this. */
const MAX_REASON = 200;

const ADVERTISEMENT_TYPE = "application/x-git-receive-pack-advertisement";
const RESULT_TYPE = "application/x-git-receive-pack-result";
const REQUEST_TYPE = "application/x-git-receive-pack-request";

/** Printable text of bounded length: what a remote says is shown to a person. */
const tidy = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim()
    .slice(0, MAX_REASON);

/**
 * Reads the body of `GET info/refs?service=git-receive-pack`: the service
 * line and its flush, then a ref a line, the first carrying the
 * capabilities after a NUL. An empty repository shows one line,
 * `capabilities^{}`, with zeros for its id.
 */
export function parseReceiveAdvertisement(body: Uint8Array): ReceiveAdvertisement {
  const refs = new Map<string, ObjectId>();
  const extraHaves: ObjectId[] = [];
  let capabilities = new Set<string>();
  let at = 0;
  // The service line, the flush after it, then the refs up to their flush.
  let stage: "service" | "gap" | "refs" = "service";
  let first = true;
  const bad = (what: string): never => {
    throw new SendPackError("bad-answer", `The remote's list of refs could not be read: ${what}`);
  };
  while (at < body.length) {
    if (at + 4 > body.length) bad("it ends inside a length");
    const length = Number.parseInt(decodeText(body.subarray(at, at + 4)), 16);
    if (!Number.isFinite(length) || length === 1 || length === 2 || length === 3) {
      bad("a length is not valid");
    }
    if (length === 0) {
      at += 4;
      if (stage === "service") bad("it is not a smart HTTP answer");
      if (stage === "refs") break;
      stage = "refs";
      continue;
    }
    if (at + length > body.length) bad("it ends inside a line");
    const payload = body.subarray(at + 4, at + length);
    at += length;
    let line = decodeText(payload);
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (stage === "service") {
      if (line !== "# service=git-receive-pack") bad("it is not a smart HTTP answer");
      stage = "gap";
      continue;
    }
    if (stage === "gap") bad("the service line is not followed by a flush");
    // Protocol v1 says so before the refs; they follow as in v0.
    if (line === "version 1") continue;
    if (line.startsWith("ERR ")) {
      throw new SendPackError("bad-answer", `The remote refused: ${tidy(line.slice(4))}`);
    }
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (first) capabilities = parseCapabilities(line.slice(nul + 1));
      line = line.slice(0, nul);
    }
    first = false;
    const space = line.indexOf(" ");
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (space !== 40 || !isObjectId(oid)) bad("a line does not start with an object id");
    if (name === "capabilities^{}") continue;
    if (name === ".have") {
      extraHaves.push(oid);
      continue;
    }
    // A name that is not a ref's is skipped rather than trusted: it is only ever compared and sent back.
    if (!isValidRefName(name)) continue;
    refs.set(name, oid);
  }
  if (stage !== "refs") bad("it is not a smart HTTP answer");
  return { refs, extraHaves, capabilities };
}

/** The capabilities this client asks for, of those the remote offers. */
export function chooseSendPackCapabilities(
  offered: ReadonlySet<string>,
  agent: string = DEFAULT_AGENT,
): string[] {
  const chosen: string[] = [];
  if (offered.has("report-status")) chosen.push("report-status");
  if (offered.has("side-band-64k")) chosen.push("side-band-64k");
  if (offered.has("ofs-delta")) chosen.push("ofs-delta");
  // Progress is never shown to anyone, so the remote need not write it.
  if (offered.has("quiet")) chosen.push("quiet");
  if (offered.has("object-format=sha1")) chosen.push("object-format=sha1");
  if ([...offered].some((capability) => capability.startsWith("agent="))) {
    chosen.push(`agent=${agent}`);
  }
  return chosen;
}

/** The start of a push's body: the commands, the first with the capabilities, and a flush. */
export function encodeSendPackCommands(
  commands: readonly SendPackCommand[],
  capabilities: readonly string[],
): Uint8Array {
  if (commands.length === 0) throw new GitError("bad-ref", "a push needs at least one ref");
  const parts: Uint8Array[] = [];
  commands.forEach((command, index) => {
    if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
      throw new GitError("bad-object", "a ref command needs two object ids");
    }
    if (!isValidRefName(command.name)) {
      throw new GitError("bad-ref", "a ref command needs a valid ref name");
    }
    const line = `${command.oldOid} ${command.newOid} ${command.name}`;
    parts.push(encodePktLine(index === 0 ? `${line}\0 ${capabilities.join(" ")}\n` : `${line}\n`));
  });
  parts.push(FLUSH_PKT);
  return concatBytes(parts);
}

/** `source`, failing once more than `limit` bytes have come through. */
async function* bounded(source: ByteSource, limit: number): AsyncGenerator<Uint8Array, void, void> {
  let seen = 0;
  for await (const chunk of iterateBytes(source)) {
    seen += chunk.length;
    if (seen > limit) {
      throw new SendPackError(
        "bad-answer",
        "The remote's answer is larger than a push's answer is",
      );
    }
    yield chunk;
  }
}

/**
 * Reads the answer to a push: `unpack ok` or `unpack <error>`, then
 * `ok <ref>` or `ng <ref> <reason>` a ref. With `sideBand` the lines arrive
 * inside channel 1 of side-band packets, cut wherever the remote cut them;
 * progress on channel 2 is dropped.
 */
export async function readSendPackReport(
  body: ByteSource,
  sideBand: boolean,
): Promise<SendPackReport> {
  const outer = new PktLineReader(bounded(body, MAX_REPORT_BYTES));
  const reader = sideBand ? new PktLineReader(demuxSideBand(outer)) : outer;
  let unpackError: string | null = null;
  let sawUnpack = false;
  const refs = new Map<string, string | null>();
  try {
    for (;;) {
      const pkt = await reader.read();
      if (pkt === null || pkt.type !== "data") break;
      let line = decodeText(pkt.data);
      if (line.endsWith("\n")) line = line.slice(0, -1);
      if (line.startsWith("unpack ")) {
        sawUnpack = true;
        const said = line.slice(7);
        unpackError = said === "ok" ? null : tidy(said) || "the pack was refused";
      } else if (line.startsWith("ok ")) {
        refs.set(line.slice(3), null);
      } else if (line.startsWith("ng ")) {
        const rest = line.slice(3);
        const space = rest.indexOf(" ");
        const name = space < 0 ? rest : rest.slice(0, space);
        refs.set(name, (space < 0 ? "" : tidy(rest.slice(space + 1))) || "refused");
      }
      // `option ...` lines of report-status-v2 and anything newer are skipped.
    }
  } catch (error) {
    if (error instanceof SendPackError) throw error;
    // A side-band error packet carries the remote's own words.
    const said = error instanceof GitError ? tidy(error.message) : "";
    throw new SendPackError(
      "bad-answer",
      said.startsWith("remote error:")
        ? `The remote refused the push: ${said.slice("remote error:".length).trim()}`
        : "The remote's answer to the push could not be read",
    );
  } finally {
    await outer.cancel().catch(() => undefined);
  }
  if (!sawUnpack) {
    throw new SendPackError("bad-answer", "The remote did not say whether it took the push");
  }
  return { unpackError, refs };
}

/** The `fetch` a push is made with. The caller's wrapper adds nothing of its own to a request. */
export type SendPackFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SendPackRemote {
  /** The repository's address, without `info/refs` (`https://host/owner/name.git`). No credentials in it. */
  readonly url: string;
  /** The value of the `Authorization` header, or null for none. */
  readonly authorization: string | null;
  readonly fetch: SendPackFetch;
  readonly signal?: AbortSignal;
  /** Sent as `User-Agent` and in the `agent=` capability. */
  readonly agent?: string;
}

const endpoint = (base: string, path: string): string => `${base.replace(/\/+$/, "")}/${path}`;

const headersFor = (
  remote: SendPackRemote,
  extra: Record<string, string>,
): Record<string, string> => ({
  "user-agent": `git/${remote.agent ?? DEFAULT_AGENT}`,
  ...(remote.authorization !== null ? { authorization: remote.authorization } : {}),
  ...extra,
});

/** What a status that is not 200 means, in words that name neither the address nor the credential. */
const refusal = (status: number, doing: string): SendPackError => {
  if (status === 401) {
    return new SendPackError("unauthorized", "The remote refused the credential", status);
  }
  if (status === 403) {
    return new SendPackError(
      "forbidden",
      "The remote does not let this credential push to the repository",
      status,
    );
  }
  if (status === 404) {
    return new SendPackError(
      "not-found",
      "The remote has no such repository, or the credential cannot see it",
      status,
    );
  }
  if (status >= 300 && status < 400) {
    return new SendPackError(
      "redirected",
      "The remote answered with a redirect, which a mirror does not follow: use the address it redirects to",
      status,
    );
  }
  return new SendPackError("http", `The remote answered ${status} while ${doing}`, status);
};

const mediaType = (response: Response): string =>
  (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

async function readBounded(body: ByteSource | null, limit: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  for await (const chunk of bounded(body, limit)) chunks.push(chunk);
  return concatBytes(chunks);
}

/** Asks the remote for its refs and what its receive-pack can do. Redirects are not followed. */
export async function fetchReceiveAdvertisement(
  remote: SendPackRemote,
): Promise<ReceiveAdvertisement> {
  const response = await remote.fetch(endpoint(remote.url, "info/refs?service=git-receive-pack"), {
    method: "GET",
    redirect: "manual",
    headers: headersFor(remote, { accept: "*/*", pragma: "no-cache" }),
    ...(remote.signal ? { signal: remote.signal } : {}),
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw refusal(response.status, "listing its refs");
  }
  if (mediaType(response) !== ADVERTISEMENT_TYPE) {
    await response.body?.cancel().catch(() => undefined);
    throw new SendPackError(
      "not-git",
      "The address does not answer as a Git repository over smart HTTP",
      response.status,
    );
  }
  return parseReceiveAdvertisement(await readBounded(response.body, MAX_ADVERTISEMENT_BYTES));
}

export interface SendPackInput {
  readonly commands: readonly SendPackCommand[];
  /** What the remote offered ({@link ReceiveAdvertisement.capabilities}). */
  readonly offered: ReadonlySet<string>;
  /**
   * The pack with every object the new values need and the remote lacks.
   * Null when every command is a deletion: git sends no pack then. Read
   * only once, by the request.
   */
  readonly pack: ReadableStream<Uint8Array> | null;
}

/**
 * One push: the commands and the pack in a single request, its body
 * streamed. Answers what the remote said for the pack and for each ref; a
 * ref the remote did not answer for is reported as not having moved.
 */
export async function sendPack(
  remote: SendPackRemote,
  input: SendPackInput,
): Promise<SendPackReport> {
  if (!input.offered.has("report-status")) {
    throw new SendPackError(
      "bad-answer",
      "The remote cannot say whether a push worked, so nothing is pushed to it",
    );
  }
  const deletes = input.commands.some((command) => command.newOid === ZERO_OID);
  if (deletes && !input.offered.has("delete-refs")) {
    throw new SendPackError("bad-answer", "The remote does not take deletions of refs");
  }
  const capabilities = chooseSendPackCapabilities(input.offered, remote.agent);
  const head = encodeSendPackCommands(input.commands, capabilities);
  const pack = input.pack;
  async function* body(): AsyncGenerator<Uint8Array, void, void> {
    yield head;
    if (pack !== null) yield* iterateBytes(pack);
  }
  let response: Response;
  try {
    response = await remote.fetch(endpoint(remote.url, "git-receive-pack"), {
      method: "POST",
      redirect: "manual",
      headers: headersFor(remote, { "content-type": REQUEST_TYPE, accept: RESULT_TYPE }),
      body: streamFrom(body()),
      // A body that is a stream needs this said (it is not in every `RequestInit` type yet).
      duplex: "half",
      ...(remote.signal ? { signal: remote.signal } : {}),
    } as RequestInit);
  } catch (error) {
    await pack?.cancel().catch(() => undefined);
    throw error;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw refusal(response.status, "taking the push");
  }
  if (mediaType(response) !== RESULT_TYPE || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new SendPackError("bad-answer", "The remote's answer to the push is not a Git one");
  }
  const report = await readSendPackReport(response.body, capabilities.includes("side-band-64k"));
  const refs = new Map(report.refs);
  for (const command of input.commands) {
    if (!refs.has(command.name)) {
      refs.set(command.name, report.unpackError ?? "the remote did not answer for this ref");
    }
  }
  return { unpackError: report.unpackError, refs };
}
