// `infrawrench status-pages`: the org's public status pages, what each one
// publishes, and the URL it is live at.
//
// Cloud-only, like the probes they publish: the checks run in the cloud poller
// and the page is served by the cloud web app, so a local workspace has
// nothing to list. The CLI lists; creating and editing pages (and the
// publish decision in particular) lives on the web/desktop Probes tab.
//
// Listing it here is the point, though: the one thing worth being able to ask
// from a terminal is "what of our monitoring is currently public, and where?".
//
// The response shapes come from `@infrawrench/client-core` (the same
// definitions every other surface renders) so a server-side change breaks the
// CLI's build instead of its output. The imports are type-only, so the CLI
// still ships zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { StatusPageListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c } from "../output";
import { CLOUD_URL } from "../../../env";

const PATH = "/status-pages";

// `probeStatus` stays a string: anything but up or down renders as pending.
const PageList = wire<StatusPageListResponse>()(
  Schema.Struct({
    pages: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        slug: Schema.String,
        title: Schema.String,
        description: Schema.NullOr(Schema.String),
        published: Schema.Boolean,
        showHistory: Schema.Boolean,
        showUptime: Schema.Boolean,
        components: Schema.Array(
          Schema.Struct({
            label: Schema.NullOr(Schema.String),
            groupName: Schema.NullOr(Schema.String),
            probeName: Schema.String,
            probeStatus: Schema.String,
            probeEnabled: Schema.Boolean,
          }),
        ),
      }),
    ),
  }),
);
type StatusPage = (typeof PageList.Type)["pages"][number];

/** The list with each page left as the server sent it, for `--json`. */
const RawPageList = Schema.Struct({ pages: Schema.Array(Schema.Unknown) });

/** The public URL of a page. Mirrors client-core's `statusPageUrl`. */
function pageUrl(origin: string, page: StatusPage): string {
  return `${origin.replace(/\/+$/, "")}/status/${page.slug}`;
}

/** The page `wanted` names: id, then exact title, then a title containing it. */
function findPage(pages: ReadonlyArray<StatusPage>, wanted: string): number {
  const needle = wanted.toLowerCase();
  const byId = pages.findIndex((p) => p.id === wanted);
  if (byId >= 0) return byId;
  const exact = pages.findIndex((p) => p.title.toLowerCase() === needle);
  if (exact >= 0) return exact;
  return pages.findIndex((p) => p.title.toLowerCase().includes(needle));
}

const printList = Effect.fnUntraced(function* (orgName: string, pages: ReadonlyArray<StatusPage>) {
  if (pages.length === 0) {
    return yield* Print.line(
      c.dim(
        "No status pages yet. Create one from the Probes tab. A page publishes probes you already run.",
      ),
    );
  }

  yield* Print.line(
    `${c.bold(orgName)} ${c.dim(`· ${pages.length} status page${pages.length === 1 ? "" : "s"}`)}`,
  );
  yield* Print.line();
  yield* Print.table(pages, [
    { header: "page", value: (p) => p.title },
    {
      header: "state",
      value: (p) => (p.published ? c.green("● live") : c.dim("○ draft")),
    },
    { header: "components", value: (p) => String(p.components.length), align: "right" },
    // The URL is printed for drafts too: knowing where a page *will* be is how
    // you check it before publishing.
    { header: "url", value: (p) => c.dim(pageUrl(CLOUD_URL, p)) },
  ]);

  const live = pages.filter((p) => p.published).length;
  yield* Print.line();
  yield* Print.line(
    c.dim(
      live === 0
        ? "Nothing is published. A page is reachable only once you publish it."
        : `${live} page${live === 1 ? " is" : "s are"} readable by anyone with the link.`,
    ),
  );
});

const printPageDetail = Effect.fnUntraced(function* (page: StatusPage) {
  yield* Print.line(
    `${c.bold(page.title)} ${page.published ? c.green("· live") : c.dim("· draft")}`,
  );
  if (page.description) yield* Print.line(c.dim(page.description));
  yield* Print.line();
  yield* Print.line(`${c.dim("url")}  ${pageUrl(CLOUD_URL, page)}`);
  yield* Print.line(
    `${c.dim("shows")}  ${
      [page.showUptime ? "24h uptime" : null, page.showHistory ? "90d history" : null]
        .filter(Boolean)
        .join(", ") || "current state only"
    }`,
  );

  if (page.components.length === 0) {
    yield* Print.line();
    return yield* Print.line(c.dim("No components. This page publishes nothing."));
  }

  yield* Print.line();
  yield* Print.table(page.components, [
    { header: "public name", value: (comp) => comp.label ?? comp.probeName },
    { header: "group", value: (comp) => c.dim(comp.groupName ?? "—") },
    { header: "probe", value: (comp) => c.dim(comp.probeName) },
    {
      header: "state",
      value: (comp) =>
        !comp.probeEnabled
          ? c.dim("○ paused")
          : comp.probeStatus === "up"
            ? c.green("● up")
            : comp.probeStatus === "down"
              ? c.red("● down")
              : c.yellow("● pending"),
    },
  ]);

  const paused = page.components.filter((comp) => !comp.probeEnabled).length;
  if (paused > 0) {
    yield* Print.line();
    yield* Print.line(
      c.dim(
        `${paused} probe${paused === 1 ? "" : "s"} paused. Those components show as "No data" to visitors.`,
      ),
    );
  }
});

export const statusPages = Command.make(
  "status-pages",
  {
    page: Argument.String("name|id").pipe(
      Argument.withDescription("A page to detail, by id or title"),
      Argument.optional,
    ),
  },
  Effect.fn("status-pages")(function* ({ page: pageArg }) {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "Status pages live in Infrawrench Cloud. The page is served by the web app. Drop --local.",
      });
    }
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);
    const raw = yield* decodeBody(RawPageList, PATH)(body);

    if (Option.isSome(pageArg)) {
      const { pages } = yield* decodeBody(PageList, PATH)(body);
      const index = findPage(pages, pageArg.value);
      const page = pages[index];
      if (!page) {
        return yield* new CliFailure({
          message: `No status page matches "${pageArg.value}". Run \`infrawrench status-pages\` to list.`,
        });
      }
      if (session.output === "json") return yield* Print.json(raw.pages[index]);
      return yield* printPageDetail(page);
    }

    if (session.output === "json") return yield* Print.json({ org: org.id, pages: raw.pages });
    const { pages } = yield* decodeBody(PageList, PATH)(body);
    yield* printList(org.displayName, pages);
  }),
).pipe(
  Command.withDescription(
    "Public status pages built from your probes: what each publishes and the URL it is live at",
  ),
);
