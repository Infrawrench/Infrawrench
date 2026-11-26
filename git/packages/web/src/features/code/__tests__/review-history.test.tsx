/**
 * The review record of a merged branch page on the default branch: where its
 * findings go on a blame, and, against the dev mock through the real router,
 * the merged commit's Review section, the marks on a blamed file and a
 * file's review history.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BlameRange, MergedFinding, MergedReview } from "@infrawrench/git-contract";
import { ApiError, setTransport, type ApiCall, type Transport } from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { routeTree } from "../../../routeTree.gen";
import { placeOnBlame, settledAs, settledText } from "../review-history";

const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const OLDER = "a".repeat(40);

const finding = (fields: Partial<MergedFinding>): MergedFinding => ({
  id: "f1",
  reviewerKind: "claude-review",
  severity: "should_fix",
  title: "A finding",
  path: "src/a.ts",
  side: "RIGHT",
  startLine: 12,
  endLine: 14,
  commitOid: HEAD,
  linesAtHead: true,
  status: "open",
  version: 1,
  fixedInVersion: null,
  dismissedBy: null,
  dismissalReason: null,
  override: null,
  ...fields,
});

const review = (findings: MergedFinding[]): MergedReview => ({
  page: { key: "feature/a", title: "A change", branch: "feature/a" },
  mergeCommitOid: MERGE,
  mergeMethod: "squash",
  mergedAt: "2026-10-01T10:00:00.000Z",
  mergedBy: null,
  versions: 2,
  ask: null,
  findings,
});

const range = (fields: Partial<BlameRange>): BlameRange => ({
  startLine: 1,
  lineCount: 10,
  commitOid: OLDER,
  originalStartLine: 1,
  originalPath: "src/a.ts",
  previousCommitOid: null,
  ...fields,
});

describe("placing findings on a blame", () => {
  it("puts a finding on the lines the squash introduced, where they are now", () => {
    // Twenty lines were added above since: the squash's lines 10 to 19 are now 30 to 39.
    const ranges = [
      range({ startLine: 1, lineCount: 29, commitOid: OLDER }),
      range({ startLine: 30, lineCount: 10, commitOid: MERGE, originalStartLine: 10 }),
    ];
    const placed = placeOnBlame(ranges, [review([finding({})])]);
    expect([...placed.starts.keys()]).toEqual([32]);
    expect([...placed.covered.keys()]).toEqual([33, 34]);
    expect(placed.unplaced).toEqual([]);
  });

  it("puts a finding on lines of the very commit its lines are numbered in", () => {
    // A merge commit keeps the branch's own commits in history: the blame names one of them.
    const ranges = [range({ startLine: 5, lineCount: 10, commitOid: HEAD, originalStartLine: 5 })];
    const page = {
      ...review([finding({ startLine: 7, endLine: 7 })]),
      mergeMethod: "merge" as const,
    };
    expect([...placeOnBlame(ranges, [page]).starts.keys()]).toEqual([7]);
  });

  it("counts what it cannot match instead of guessing a line", () => {
    const ranges = [range({ startLine: 1, lineCount: 20, commitOid: MERGE })];
    const unplaced = (fields: Partial<MergedFinding>) =>
      placeOnBlame(ranges, [review([finding(fields)])]).unplaced.length;
    // Numbered in an older version, which the merge is not.
    expect(unplaced({ commitOid: OLDER, linesAtHead: false })).toBe(1);
    // Part of it has been rewritten since: the range no longer covers every line.
    expect(unplaced({ startLine: 19, endLine: 22 })).toBe(1);
    // About the file as it was before, about no line, or about a file since renamed.
    expect(unplaced({ side: "LEFT" })).toBe(1);
    expect(unplaced({ startLine: null, endLine: null })).toBe(1);
    expect(unplaced({ path: "src/old-name.ts" })).toBe(1);
    // Lines another commit wrote.
    expect(
      placeOnBlame([range({ commitOid: OLDER, lineCount: 20 })], [review([finding({})])]).unplaced,
    ).toHaveLength(1);
  });

  it("leads with the gravest finding of a line", () => {
    const ranges = [range({ lineCount: 40, commitOid: MERGE })];
    const placed = placeOnBlame(ranges, [
      review([
        finding({ id: "note", severity: "note", startLine: 3, endLine: 3 }),
        finding({ id: "must", severity: "must_fix", startLine: 3, endLine: 3 }),
      ]),
    ]);
    expect(placed.starts.get(3)!.map((each) => each.finding.id)).toEqual(["must", "note"]);
  });
});

describe("how a finding was settled", () => {
  const mara = { id: "u1", username: "mara", displayName: "Mara", avatarUrl: null };

  it("says fixed, dismissed, open at merge or merged past, with who and why", () => {
    expect(settledAs(finding({ status: "fixed", fixedInVersion: 2 }))).toMatchObject({
      label: "Fixed in v2",
      tone: "success",
      detail: null,
    });
    expect(settledText(finding({ status: "open" }))).toBe("Open at merge");
    expect(
      settledText(
        finding({ status: "dismissed", dismissedBy: mara, dismissalReason: "Out of scope" }),
      ),
    ).toBe("Dismissed by mara: Out of scope");
    expect(
      settledText(finding({ override: { by: mara, reason: "Fixed in the next branch" } })),
    ).toBe("Merged past it. Allowed by mara: Fixed in the next branch");
    // An override of a finding that was fixed anyway says nothing.
    expect(settledAs(finding({ status: "fixed", override: null })).label).toBe("Fixed");
  });
});

/** The dev mock's handlers as a transport, without its artificial delay. */
function mockTransport(): Transport {
  const handlers = import.meta.glob<{ default: Record<string, Record<string, unknown>> }>(
    "../../../mock/handlers/*.ts",
    { eager: true },
  );
  const table = new Map<string, (request: unknown) => unknown>();
  for (const module of Object.values(handlers)) {
    for (const [group, endpoints] of Object.entries(module.default)) {
      for (const [endpoint, handler] of Object.entries(endpoints ?? {})) {
        table.set(`${group}.${endpoint}`, handler as (request: unknown) => unknown);
      }
    }
  }
  return async ({ group, endpoint, request }) => {
    const handler = table.get(`${group}.${endpoint}`);
    if (handler === undefined) throw new ApiError(501, `No mock handler for ${group}.${endpoint}`);
    const answer = await handler(request);
    return answer === undefined ? undefined : structuredClone(answer);
  };
}

const mock = mockTransport();
vi.setConfig({ testTimeout: 20_000 });
const wait = { timeout: 5000 };

beforeAll(() => {
  window.scrollTo = () => {};
  class NoLayoutObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("ResizeObserver", NoLayoutObserver);
  vi.stubGlobal("IntersectionObserver", NoLayoutObserver);
});

/** Every call goes to the mock, unless `refuse` names its endpoint: a server that does not serve it yet. */
function serve(refuse: ReadonlyArray<string> = []) {
  setTransport((call: ApiCall) =>
    refuse.includes(`${call.group}.${call.endpoint}`)
      ? Promise.reject(new ApiError(503, "Not available yet", "not_implemented"))
      : mock(call),
  );
}

function open(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  serve();
});

const FLOW_LOGS = "/acme/infra/branches/feature/flow-logs";
/** What `feature/flow-logs` was merged as, six weeks ago. */
const MERGED = "28324628b9350fd4337ff45c37b7a89d40a5079b";

describe("the commit a branch page was merged as", () => {
  it("shows the review: the ask, the versions and every finding as the merge left it", async () => {
    serve();
    open(`/acme/infra/commit/${MERGED}`);
    const section = await screen.findByRole("region", { name: "Review" }, wait);
    expect(section.textContent).toContain("2 versions");
    expect(section.textContent).toContain("2 open at merge · 1 fixed · 1 dismissed");
    expect(section.textContent).toContain("Let an environment send its VPC flow logs");
    expect(
      within(section)
        .getByRole("link", { name: /Branch page/ })
        .getAttribute("href"),
    ).toBe(FLOW_LOGS);

    const mustFix = within(section).getByRole("list", { name: "Must fix" });
    // A finding about the whole change comes before those on a file.
    const [fixed, past] = within(mustFix).getAllByRole("listitem");
    expect(past!.textContent).toContain("The bucket's ARN is written out");
    expect(past!.textContent).toContain("environments/staging/main.tf, line 27");
    expect(past!.textContent).toContain("Merged past it");
    expect(past!.textContent).toContain("Allowed by mara: The bucket is created by");
    expect(fixed!.textContent).toContain("Fixed in v2");
    // Each finding is a link to itself on the branch page.
    expect(
      within(past!)
        .getByRole("link", { name: "The bucket's ARN is written out" })
        .getAttribute("href"),
    ).toMatch(new RegExp(`^${FLOW_LOGS}#finding-`));

    const shouldFix = within(section).getByRole("list", { name: "Should fix" });
    expect(shouldFix.textContent).toContain(
      "Dismissed by mara: The audit wants accepted flows as well",
    );
    expect(within(section).getByRole("list", { name: "Note" }).textContent).toContain(
      "Open at merge",
    );
  });

  it("has no such section on any other commit, or when the server does not serve it", async () => {
    serve();
    open("/acme/infra/commit/142a748f467b577da2264d9f429f7079299a03e3");
    expect(await screen.findByText("network: optional VPC flow logs", {}, wait)).toBeTruthy();
    await screen.findByRole("region", { name: "Changes" }, wait).catch(() => null);
    expect(screen.queryByRole("region", { name: "Review" })).toBeNull();

    cleanup();
    queryClient.clear();
    serve(["contents.commitReview"]);
    open(`/acme/infra/commit/${MERGED}`);
    expect(await screen.findByText(/Merge pull request #7/, {}, wait)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Review" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a blamed file", () => {
  it("marks the lines a merged branch's findings were about, and counts the rest on its header", async () => {
    serve();
    open("/acme/infra/blame/main/modules/network/main.tf");
    const table = await screen.findByRole("table", { name: "Blame of main.tf" }, wait);
    // Dismissed on v1, whose commit still has line 101 as it wrote it.
    const mark = await within(table).findByRole(
      "link",
      { name: "1 review finding: Accepted traffic is logged too" },
      wait,
    );
    expect(mark.getAttribute("href")).toMatch(new RegExp(`^${FLOW_LOGS}#finding-`));
    expect(mark.getAttribute("title")).toBe(
      "Should fix · Dismissed by mara: The audit wants accepted flows as well\nAccepted traffic is logged too",
    );
    expect(mark.closest("tr")!.querySelector("#L101")).not.toBeNull();
    // Numbered in v2, on a line v1's commit wrote: no line is claimed for it.
    const count = screen.getByRole("button", { name: "1 review finding not on a line" });
    const history = document.getElementById("review-history") as HTMLDetailsElement;
    expect(history.open).toBe(false);
    fireEvent.click(count);
    expect(history.open).toBe(true);
    expect(history.textContent).toContain("2 findings from 1 merged branch");
    expect(history.textContent).toContain("The flow log has no Name tag");
  });

  it("marks a line of the branch's last commit", async () => {
    serve();
    open("/acme/infra/blame/main/environments/staging/main.tf");
    const table = await screen.findByRole("table", { name: "Blame of main.tf" }, wait);
    const mark = await within(table).findByRole(
      "link",
      { name: "1 review finding: The bucket's ARN is written out" },
      wait,
    );
    expect(mark.getAttribute("title")).toContain("Must fix · Merged past it. Allowed by mara");
    expect(mark.closest("tr")!.querySelector("#L27")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /not on a line/ })).toBeNull();
  });

  it("is the blame alone where no branch left a finding", async () => {
    serve();
    open("/acme/infra/blame/main/modules/network/variables.tf");
    const table = await screen.findByRole("table", { name: "Blame of variables.tf" }, wait);
    expect(within(table).queryByRole("link", { name: /review finding/ })).toBeNull();
    expect(document.getElementById("review-history")).toBeNull();
  });
});

describe("a file", () => {
  it("lists the findings merged branches left on it, each a link to the finding", async () => {
    serve();
    open("/acme/infra/blob/main/modules/network/main.tf");
    const summary = await screen.findByText("Review history", {}, wait);
    const history = summary.closest("details")!;
    expect(history.open).toBe(false);
    expect(history.textContent).toContain("2 findings from 1 merged branch");
    expect(
      within(history)
        .getByRole("link", { name: "network: optional VPC flow logs" })
        .getAttribute("href"),
    ).toBe(FLOW_LOGS);
    const rows = within(history).getAllByRole("listitem");
    expect(rows.some((row) => row.textContent?.includes("Line 101"))).toBe(true);
    expect(history.textContent).toContain("Dismissed by mara");
    expect(history.textContent).not.toContain("The bucket's ARN is written out");
  });
});
