// The cloud HTTP API, as an Effect service. This is the one implementation:
// the Promise helpers in `../context.ts` (`orgFetch`, `listOrgs`,
// `resolveOrg`, ...) run these and turn the tagged errors back into
// `CliError`s with the same sentence and exit code, so unmigrated commands
// keep working unchanged.
//
// Token reads, refreshes and the network itself stay Promise calls through
// `Effect.promise`: a rejection there (a locked keychain, `fetch failed`) is a
// defect, and the runner prints it the way `runCli` always has.
import { Config, Context, Effect, Layer, Option, Schema } from "effect";
import { CLOUD_URL } from "../../../env";
import {
  fetchCloudOrgs,
  forceRefreshAccessToken,
  getAccessToken,
  getAuthStatus,
} from "../../cloud-tokens";
import {
  type CloudError,
  CloudRequestFailed,
  describeBody,
  EndpointUnavailable,
  looksLikeHtml,
  MalformedResponse,
  NotSignedIn,
  OrgNotResolved,
} from "./errors";
import { CliSession } from "./session";

export interface OrgInfo {
  id: string;
  displayName: string;
  role: string;
}

export interface AuthStatus {
  authenticated: boolean;
  email?: string | undefined;
  organizationId?: string | undefined;
}

export interface Download {
  bytes: Uint8Array;
  contentDisposition: string | null;
}

type RequestFailure = NotSignedIn | CloudRequestFailed | EndpointUnavailable;

export class CloudApi extends Context.Service<
  CloudApi,
  {
    /** An org-scoped JSON endpoint, unparsed past `JSON.parse`; `undefined` for a 204. */
    readonly json: (
      orgId: string,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<unknown, RequestFailure | MalformedResponse>;
    /** {@link json}, decoded against a schema: a body that does not fit is `MalformedResponse`. */
    readonly decode: <A>(
      schema: Schema.ConstraintDecoder<A>,
      orgId: string,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<A, RequestFailure | MalformedResponse>;
    /** An endpoint whose body is a document (the asciicast of a recorded session). */
    readonly text: (
      orgId: string,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<string, RequestFailure>;
    /** A binary download plus the `Content-Disposition` the server named it with. */
    readonly download: (
      orgId: string,
      path: string,
      init?: RequestInit,
    ) => Effect.Effect<Download, RequestFailure>;
    /** Whether there is a usable session, and whose. Never fails for "signed out". */
    readonly authStatus: Effect.Effect<AuthStatus>;
    /** The signed-in user's organizations, `[]` when signed out. */
    readonly orgs: Effect.Effect<ReadonlyArray<OrgInfo>>;
    /** {@link orgs}, but signed out is `NotSignedIn`. */
    readonly listOrgs: Effect.Effect<ReadonlyArray<OrgInfo>, NotSignedIn>;
    /**
     * An org by id, exact name or unique name prefix; `wanted` null falls back
     * to `INFRAWRENCH_ORG`, then to the only org there is.
     */
    readonly resolveOrg: (
      wanted: string | null,
    ) => Effect.Effect<OrgInfo, NotSignedIn | OrgNotResolved>;
  }
>()("infrawrench/desktop/cli/CloudApi") {
  static readonly layer = Layer.sync(CloudApi)(() => makeCloudApi(CLOUD_URL));
}

/** The org `--org` (or `INFRAWRENCH_ORG`, or the only one) names. */
export const currentOrg = Effect.gen(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  return yield* api.resolveOrg(session.org);
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Decode a body {@link CloudApi.json} already returned: a body that does not
 * fit is `MalformedResponse`, as with `decode`. For a command that prints the
 * raw body under `--json` (byte for byte what the server sent, every field
 * included) and decodes only what its text rendering reads.
 */
export const decodeBody =
  <A>(schema: Schema.ConstraintDecoder<A>, path: string) =>
  (body: unknown): Effect.Effect<A, MalformedResponse> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => new MalformedResponse({ path, detail: `: ${error.message}` })),
    );

const orgUrl = (baseUrl: string, orgId: string, path: string) =>
  `${baseUrl}/api/org/${encodeURIComponent(orgId)}${path}`;

const withAuth = (init: RequestInit, token: string, json: boolean): RequestInit => ({
  ...init,
  headers: {
    ...(init.headers ?? {}),
    Authorization: `Bearer ${token}`,
    ...(json && init.body ? { "Content-Type": "application/json" } : {}),
  },
});

const readBody = (res: Response) => Effect.promise(() => res.text().catch(() => ""));

function makeCloudApi(baseUrl: string): CloudApi["Service"] {
  /** One request with the session's token, retried once after a refresh on 401. */
  const authorized = Effect.fnUntraced(function* (
    orgId: string,
    path: string,
    init: RequestInit,
    json: boolean,
  ) {
    const token = yield* Effect.promise(getAccessToken);
    if (!token) return yield* new NotSignedIn();
    const url = orgUrl(baseUrl, orgId, path);
    const res = yield* Effect.promise(() => fetch(url, withAuth(init, token, json)));
    if (res.status !== 401) return res;
    const refreshed = yield* Effect.promise(forceRefreshAccessToken);
    if (!refreshed) return yield* new NotSignedIn();
    return yield* Effect.promise(() => fetch(url, withAuth(init, refreshed, json)));
  });

  const unavailable = (path: string, expected: string) =>
    new EndpointUnavailable({ path, baseUrl, expected });

  const json = Effect.fnUntraced(function* (orgId: string, path: string, init: RequestInit = {}) {
    const res = yield* authorized(orgId, path, init, true);
    const body = yield* readBody(res);
    if (!res.ok) return yield* new CloudRequestFailed({ status: res.status, path, body });
    // 204 No Content (the dismissal DELETEs answer with it): there is nothing
    // to parse, and treating the empty body as malformed fails a request that worked.
    if (res.status === 204) return undefined;
    return yield* decodeJson(body).pipe(
      // A 200 that isn't JSON almost always means the SPA's catch-all served
      // an HTML page because this route doesn't exist on that server.
      Effect.mapError(() =>
        looksLikeHtml(body)
          ? unavailable(path, "data")
          : new MalformedResponse({ path, detail: describeBody(body) }),
      ),
    );
  });

  const decode = <A>(
    schema: Schema.ConstraintDecoder<A>,
    orgId: string,
    path: string,
    init: RequestInit = {},
  ) => json(orgId, path, init).pipe(Effect.flatMap(decodeBody(schema, path)));

  const text = Effect.fnUntraced(function* (orgId: string, path: string, init: RequestInit = {}) {
    const res = yield* authorized(orgId, path, init, false);
    const body = yield* readBody(res);
    if (!res.ok) return yield* new CloudRequestFailed({ status: res.status, path, body });
    if (looksLikeHtml(body)) return yield* unavailable(path, "data");
    return body;
  });

  const download = Effect.fnUntraced(function* (
    orgId: string,
    path: string,
    init: RequestInit = {},
  ) {
    const res = yield* authorized(orgId, path, init, false);
    if (!res.ok) {
      const body = yield* readBody(res);
      return yield* new CloudRequestFailed({ status: res.status, path, body });
    }
    const bytes = new Uint8Array(yield* Effect.promise(() => res.arrayBuffer()));
    const contentType = res.headers.get("content-type") ?? "";
    const head = new TextDecoder().decode(bytes.subarray(0, 200));
    if (contentType.includes("text/html") || looksLikeHtml(head)) {
      return yield* unavailable(path, "a file");
    }
    return { bytes, contentDisposition: res.headers.get("content-disposition") };
  });

  const authStatus = Effect.promise(getAuthStatus);
  // `fetchCloudOrgs` answers `[]` for "signed out" and throws for a failed
  // request, so a failure stays a defect with its own message.
  const orgs = Effect.promise(fetchCloudOrgs);

  const listOrgs = Effect.gen(function* () {
    const token = yield* Effect.promise(getAccessToken);
    if (!token) return yield* new NotSignedIn();
    return yield* orgs;
  });

  const resolveOrg = Effect.fnUntraced(function* (flag: string | null) {
    const all = yield* listOrgs;
    if (all.length === 0) {
      return yield* new OrgNotResolved({ reason: "no-orgs", wanted: null, candidates: [] });
    }
    const fromEnv = yield* Config.option(Config.String("INFRAWRENCH_ORG")).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const wanted = flag ?? Option.getOrNull(fromEnv);
    if (!wanted) {
      const [only] = all;
      if (only && all.length === 1) return only;
      return yield* new OrgNotResolved({
        reason: "unspecified",
        wanted: null,
        candidates: [...all],
      });
    }
    const byId = all.find((o) => o.id === wanted);
    if (byId) return byId;
    const byName = all.filter((o) => o.displayName.toLowerCase().startsWith(wanted.toLowerCase()));
    const [match] = byName;
    if (match && byName.length === 1) return match;
    return yield* new OrgNotResolved({
      reason: byName.length === 0 ? "no-match" : "ambiguous",
      wanted,
      candidates: byName,
    });
  });

  return CloudApi.of({ json, decode, text, download, authStatus, orgs, listOrgs, resolveOrg });
}

/** Run a `CloudApi` call outside the Effect runtime (the legacy Promise helpers). */
export const runCloudApi = <A, E extends CloudError>(
  f: (api: CloudApi["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => CloudApi.use(f).pipe(Effect.provide(CloudApi.layer));

/**
 * `effect`, or `fallback()` when it fails for any reason, a defect (a network
 * error) included: a read the command can do without, such as an optional
 * column or a marker an older server cannot answer. The Promise code it
 * replaces was `.catch(() => fallback)`, which swallowed rejections of every kind.
 */
export const bestEffort =
  <B>(fallback: () => B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    effect.pipe(
      Effect.orElseSucceed(fallback),
      Effect.catchDefect(() => Effect.succeed(fallback())),
    );

/** {@link attempt}'s answer: the value, or the sentence the call failed with. */
export type Attempt<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string };

/**
 * Run `effect` and answer with its value or the sentence it failed with (a
 * typed error's message, a defect's), for a loop that reports each failure and
 * carries on: one delivery of several, one card of a dashboard.
 */
export const attempt = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Attempt<A>, never, R> =>
  effect.pipe(
    Effect.map((value): Attempt<A> => ({ ok: true, value })),
    Effect.catch((e) => Effect.succeed<Attempt<A>>({ ok: false, error: e.message })),
    Effect.catchDefect((d) =>
      Effect.succeed<Attempt<A>>({
        ok: false,
        error: d instanceof Error ? d.message : String(d),
      }),
    ),
  );
