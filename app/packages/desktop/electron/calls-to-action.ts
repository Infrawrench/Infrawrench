/**
 * Calls to action: announcements the desktop reads from a JSON file on the
 * website (`CALLS_TO_ACTION_URL`, `website/public/desktop/calls-to-action/`)
 * and shows once each, over the whole window.
 *
 * The file is `{ "callsToAction": [entry, ...] }`. An entry shows when
 *
 * - its `addedAt` is after this install's first launch (`installedAt`), so a
 *   fresh install never sees the backlog,
 * - its `id` has never been acted on or dismissed here,
 * - `expiresAt`, if set, has not passed, and
 * - every condition in `when` holds: `os` (any of `mac`, `windows`, `linux`),
 *   `account` (`local`: not signed in to Infrawrench Cloud; `cloud`: signed
 *   in), `minAppVersion` / `maxAppVersion` (inclusive, `1.2.3`).
 *
 * An entry this build cannot fully understand (an unknown action type, an
 * unknown `when` condition, a malformed field) is skipped rather than shown
 * with part of its meaning missing, so a newer file can add conditions
 * without older apps misreading them. The body is markdown, inline
 * (`markdown`) or in a file beside the JSON (`markdownFile`, resolved against
 * the JSON's URL and held to its origin). KNOWLEDGE.md ("Calls to action") has
 * a full example.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { CALLS_TO_ACTION_URL, SHOW_SIGN_IN_BUTTON } from "../env";
import {
  CallToActionAction,
  CallToActionLayout,
  type PendingCallToAction,
} from "../shared/rpc/groups/calls-to-action";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Version = Schema.String.check(Schema.isPattern(/^\d+(\.\d+){0,2}$/));
const OsName = Schema.Literals(["mac", "windows", "linux"]);
export type CallToActionOs = typeof OsName.Type;

/** The conditions an entry may set; any other key skips the entry. */
const When = Schema.Struct({
  os: Schema.optionalKey(Schema.Array(OsName)),
  account: Schema.optionalKey(Schema.Literals(["local", "cloud"])),
  minAppVersion: Schema.optionalKey(Version),
  maxAppVersion: Schema.optionalKey(Version),
});
type When = typeof When.Type;
/** Strict: a condition this build does not know fails the decode. */
const decodeWhen = Schema.decodeUnknownOption(When, { onExcessProperty: "error" });

const Text = {
  markdown: Schema.optionalKey(NonEmpty),
  markdownFile: Schema.optionalKey(NonEmpty),
  actionLabel: Schema.optionalKey(NonEmpty),
  dismissLabel: Schema.optionalKey(NonEmpty),
};

const Entry = Schema.Struct({
  id: NonEmpty,
  addedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  action: CallToActionAction,
  layout: Schema.optionalKey(CallToActionLayout),
  /** Decoded strictly by `decodeWhen`, apart from the rest of the entry. */
  when: Schema.optionalKey(Schema.Unknown),
  /** Per-locale overrides of the text fields, keyed `fr`, `pt-BR`, ... */
  translations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct(Text))),
  ...Text,
});
type Entry = typeof Entry.Type;

const Manifest = Schema.Struct({ callsToAction: Schema.Array(Schema.Unknown) });

const State = Schema.Struct({
  installedAt: Schema.DateTimeUtcFromString,
  completed: Schema.Record(Schema.String, Schema.String),
});
type State = typeof State.Type;
const StateJson = Schema.fromJsonString(State);

const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));
const decodeState = Schema.decodeUnknownOption(StateJson);
const encodeState = Schema.encodeSync(StateJson);

/** Where an entry's body comes from once its locale is chosen. */
export type CallToActionBody = { readonly markdown: string } | { readonly markdownFile: string };

export interface SelectedCallToAction {
  readonly id: string;
  readonly body: CallToActionBody;
  readonly action: CallToActionAction;
  readonly actionLabel: string | null;
  readonly dismissLabel: string | null;
  readonly layout: CallToActionLayout;
}

export interface CallToActionContext {
  readonly installedAt: DateTime.Utc;
  readonly now: DateTime.Utc;
  readonly completed: ReadonlySet<string>;
  readonly os: CallToActionOs;
  readonly appVersion: string;
  readonly signedIn: boolean;
  /** This build offers cloud sign-in at all (`SHOW_SIGN_IN_BUTTON`). */
  readonly signInAvailable: boolean;
  readonly locale: string;
}

export function osName(platform: NodeJS.Platform): CallToActionOs {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

/** Compares dotted numeric versions; a pre-release suffix (`-beta.1`) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split("-")[0] ?? "").split(".").map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The translation for `locale`: exact (any case), then the same language. */
function translationFor(entry: Entry, locale: string) {
  const translations = entry.translations;
  if (!translations) return undefined;
  const wanted = locale.toLowerCase();
  const language = wanted.split("-")[0];
  const keys = Object.keys(translations);
  const key =
    keys.find((k) => k.toLowerCase() === wanted) ??
    keys.find((k) => k.toLowerCase() === language) ??
    keys.find((k) => k.toLowerCase().split("-")[0] === language);
  return key === undefined ? undefined : translations[key];
}

function conditionsHold(entry: Entry, ctx: CallToActionContext): boolean {
  if (entry.action.type === "sign-in" && (ctx.signedIn || !ctx.signInAvailable)) return false;
  if (entry.when === undefined) return true;
  const decoded = decodeWhen(entry.when);
  if (Option.isNone(decoded)) return false;
  const when: When = decoded.value;
  if (when.os && !when.os.includes(ctx.os)) return false;
  if (when.account === "local" && ctx.signedIn) return false;
  if (when.account === "cloud" && !ctx.signedIn) return false;
  if (when.minAppVersion && compareVersions(ctx.appVersion, when.minAppVersion) < 0) return false;
  if (when.maxAppVersion && compareVersions(ctx.appVersion, when.maxAppVersion) > 0) return false;
  return true;
}

/**
 * The entries of a decoded manifest to show now, oldest first, with their
 * text in the context's locale. Malformed entries are skipped one by one.
 */
export function selectCallsToAction(
  entries: ReadonlyArray<unknown>,
  ctx: CallToActionContext,
): SelectedCallToAction[] {
  const selected: Array<{ addedAt: DateTime.Utc; value: SelectedCallToAction }> = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const decoded = decodeEntry(raw);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (ctx.completed.has(entry.id)) continue;
    if (!DateTime.isGreaterThan(entry.addedAt, ctx.installedAt)) continue;
    // An `addedAt` still ahead is scheduled: it shows from then on.
    if (!DateTime.isGreaterThanOrEqualTo(ctx.now, entry.addedAt)) continue;
    if (entry.expiresAt && !DateTime.isGreaterThan(entry.expiresAt, ctx.now)) continue;
    if (entry.action.type === "url" && !/^https?:\/\//i.test(entry.action.url)) continue;
    if (!conditionsHold(entry, ctx)) continue;

    const t = translationFor(entry, ctx.locale);
    // A translation with its own body replaces the body whichever form it takes.
    const markdown = t?.markdown ?? (t?.markdownFile ? undefined : entry.markdown);
    const markdownFile = t?.markdownFile ?? (t?.markdown ? undefined : entry.markdownFile);
    const body: CallToActionBody | null =
      markdown !== undefined ? { markdown } : markdownFile !== undefined ? { markdownFile } : null;
    if (!body) continue;

    selected.push({
      addedAt: entry.addedAt,
      value: {
        id: entry.id,
        body,
        action: entry.action,
        actionLabel: t?.actionLabel ?? entry.actionLabel ?? null,
        dismissLabel: t?.dismissLabel ?? entry.dismissLabel ?? null,
        layout: entry.layout ?? "stacked",
      },
    });
  }
  return selected
    .sort((a, b) => DateTime.toEpochMillis(a.addedAt) - DateTime.toEpochMillis(b.addedAt))
    .map((s) => s.value);
}

/**
 * `markdownFile` against the manifest's URL, refused if it leaves the
 * manifest's origin: the body is fetched by the app and shown as ours.
 */
export function resolveMarkdownUrl(manifestUrl: string, file: string): string | null {
  try {
    const base = new URL(manifestUrl);
    const resolved = new URL(file, base);
    return resolved.origin === base.origin ? resolved.href : null;
  } catch {
    return null;
  }
}

const MANIFEST_MAX_BYTES = 256 * 1024;
const MARKDOWN_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface CallsToActionDeps {
  readonly manifestUrl: string;
  readonly signInAvailable: boolean;
  readonly stateDir: () => string;
  readonly appVersion: () => string;
  readonly platform: NodeJS.Platform;
  readonly fetch: typeof globalThis.fetch;
}

class FetchFailed extends Schema.TaggedError<FetchFailed>()("FetchFailed", {
  message: Schema.String,
}) {}

const STATE_FILE = "calls-to-action.json";

/**
 * When this install first ran. For an install that predates this feature the
 * oldest of the files every launch leaves in userData stands in for it (the
 * master key is written once; the database is created on first launch), so
 * a call to action added after someone installed still reaches them.
 */
function firstLaunchMillis(dir: string, nowMs: number): number {
  let earliest = nowMs;
  for (const name of ["master.key.enc", "master.key", "infrawrench.db"]) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      for (const t of [stat.birthtimeMs, stat.mtimeMs]) {
        if (t > 0 && t < earliest) earliest = t;
      }
    } catch {
      /* not there */
    }
  }
  return earliest;
}

export function makeCallsToAction(deps: CallsToActionDeps) {
  const statePath = () => path.join(deps.stateDir(), STATE_FILE);

  const writeState = (state: State) =>
    Effect.try(() => {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), encodeState(state));
    }).pipe(Effect.catch((e) => Effect.logWarning("[calls-to-action] could not save state", e)));

  /** The saved state, created (and saved) on first use. */
  const loadState = Effect.gen(function* () {
    const text = yield* Effect.sync(() => {
      try {
        return fs.readFileSync(statePath(), "utf8");
      } catch {
        return null;
      }
    });
    const saved = text === null ? Option.none() : decodeState(text);
    if (Option.isSome(saved)) return saved.value;
    const now = yield* DateTime.now;
    const installedAt = DateTime.makeUnsafe(
      firstLaunchMillis(deps.stateDir(), DateTime.toEpochMillis(now)),
    );
    const fresh: State = { installedAt, completed: {} };
    yield* writeState(fresh);
    return fresh;
  });

  const fetchText = (url: string, maxBytes: number) =>
    Effect.tryPromise({
      try: async (signal) => {
        const res = await deps.fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
          redirect: "error",
        });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        const text = await res.text();
        if (text.length > maxBytes) throw new Error(`${url} is over ${maxBytes} bytes`);
        return text;
      },
      catch: (e) => new FetchFailed({ message: e instanceof Error ? e.message : String(e) }),
    });

  const pending = Effect.fn("CallsToAction.pending")(
    function* (input: { readonly signedIn: boolean; readonly locale: string }) {
      if (!deps.manifestUrl) return [];
      const state = yield* loadState;
      const manifest = decodeManifest(yield* fetchText(deps.manifestUrl, MANIFEST_MAX_BYTES));
      if (Option.isNone(manifest)) {
        yield* Effect.logWarning("[calls-to-action] the manifest is not a calls-to-action file");
        return [];
      }
      const selected = selectCallsToAction(manifest.value.callsToAction, {
        installedAt: state.installedAt,
        now: yield* DateTime.now,
        completed: new Set(Object.keys(state.completed)),
        os: osName(deps.platform),
        appVersion: deps.appVersion(),
        signedIn: input.signedIn,
        signInAvailable: deps.signInAvailable,
        locale: input.locale,
      });
      const ready = yield* Effect.forEach(
        selected,
        (cta) =>
          Effect.gen(function* () {
            let markdown: string;
            if ("markdown" in cta.body) {
              markdown = cta.body.markdown;
            } else {
              const url = resolveMarkdownUrl(deps.manifestUrl, cta.body.markdownFile);
              if (!url) {
                yield* Effect.logWarning(
                  `[calls-to-action] ${cta.id}: markdownFile leaves the site`,
                );
                return Option.none<PendingCallToAction>();
              }
              markdown = yield* fetchText(url, MARKDOWN_MAX_BYTES);
            }
            return Option.some<PendingCallToAction>({
              id: cta.id,
              markdown,
              action: cta.action,
              actionLabel: cta.actionLabel,
              dismissLabel: cta.dismissLabel,
              layout: cta.layout,
            });
          }).pipe(
            // One unreachable body skips that call to action, not the rest.
            Effect.catch((e) =>
              Effect.as(
                Effect.logWarning(`[calls-to-action] ${cta.id}: ${e.message}`),
                Option.none<PendingCallToAction>(),
              ),
            ),
          ),
        { concurrency: 4 },
      );
      return ready.flatMap((o) => (Option.isSome(o) ? [o.value] : []));
    },
    (effect) =>
      Effect.catch(effect, (e) =>
        Effect.as(Effect.logWarning(`[calls-to-action] ${e.message}`), []),
      ),
  );

  const complete = Effect.fn("CallsToAction.complete")(function* (id: string) {
    const state = yield* loadState;
    if (id in state.completed) return;
    const now = yield* DateTime.now;
    yield* writeState({
      ...state,
      completed: { ...state.completed, [id]: DateTime.formatIso(now) },
    });
  });

  return { pending, complete };
}

export class CallsToAction extends Context.Service<
  CallsToAction,
  {
    readonly pending: (input: {
      readonly signedIn: boolean;
      readonly locale: string;
    }) => Effect.Effect<ReadonlyArray<PendingCallToAction>>;
    readonly complete: (id: string) => Effect.Effect<void>;
  }
>()("infrawrench/desktop/CallsToAction") {
  static readonly layer = Layer.sync(CallsToAction)(() =>
    CallsToAction.of(
      makeCallsToAction({
        manifestUrl: CALLS_TO_ACTION_URL,
        signInAvailable: SHOW_SIGN_IN_BUTTON,
        stateDir: () => app.getPath("userData"),
        appVersion: () => app.getVersion(),
        platform: process.platform,
        fetch: (...args) => globalThis.fetch(...args),
      }),
    ),
  );
}
