import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CombinedStatus, CommitStatus, StatusState } from "@infrawrench/git-contract";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiCall, setTransport } from "../../api/client";
import { BioText } from "../../features/namespace/BioText";
import { CommitChecks, placeChecksBox } from "../CommitChecks";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { push: vi.fn(), replace: vi.fn() } }),
  useLocation: () => "/",
}));

const repo = { owner: "acme", repo: "infra" };
const oid = "a".repeat(40);

const status = (
  context: string,
  state: StatusState,
  extra: Partial<CommitStatus> = {},
): CommitStatus => ({
  id: context,
  context,
  state,
  description: state === "success" ? "Passed" : state === "failure" ? "Failed" : "Running",
  targetUrl: "https://app.example.test/org/o/ci/run_9",
  runId: "run_9",
  creator: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  ...extra,
});

let calls: ApiCall[] = [];
let answer: CombinedStatus;

const page = (children: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
};

beforeEach(() => {
  calls = [];
  answer = {
    sha: oid,
    state: "failure",
    statuses: [
      status("ci / lint", "success"),
      status("ci / test", "failure"),
      status("external / deploy", "pending", { runId: null, targetUrl: "javascript:alert(1)" }),
    ],
  };
  setTransport(async (call) => {
    calls.push(call);
    return answer;
  });
});
afterEach(cleanup);

describe("CommitChecks", () => {
  test("draws nothing for a commit with no checks, and asks nothing", () => {
    const { container } = page(<CommitChecks repo={repo} oid={oid} state={null} />);
    expect(container.innerHTML).toBe("");
    expect(calls).toEqual([]);
  });

  test("each state is a button that names it", () => {
    const names: Record<StatusState, string> = {
      success: "Checks passed. Show checks",
      failure: "Checks failed. Show checks",
      error: "Checks errored. Show checks",
      pending: "Checks running. Show checks",
    };
    for (const [state, name] of Object.entries(names) as Array<[StatusState, string]>) {
      page(<CommitChecks repo={repo} oid={oid} state={state} />);
      expect(screen.getByRole("button", { name }).getAttribute("aria-expanded")).toBe("false");
      cleanup();
    }
    // A row of them costs no request until one is opened.
    expect(calls).toEqual([]);
  });

  test("a press lists each check, worst first, linked to its run on this site", async () => {
    page(<CommitChecks repo={repo} oid={oid} state="failure" />);
    fireEvent.click(screen.getByRole("button", { name: /Show checks/ }));
    const box = await screen.findByRole("dialog", { name: "Checks" });
    const rows = await within(box).findAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/ \/ /).textContent)).toEqual([
      "ci / test",
      "external / deploy",
      "ci / lint",
    ]);
    expect(within(box).getByText("3 checks")).toBeTruthy();
    expect(within(box).getByText("1 failed, 1 running, 1 passed")).toBeTruthy();
    // One request, for this commit, whatever the number of checks.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      group: "statuses",
      endpoint: "forRef",
      request: { params: repo, query: { ref: oid } },
    });
    const links = within(box).getAllByRole("link", { name: "Details" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/acme/infra/ci/runs/run_9",
      "/acme/infra/ci/runs/run_9",
    ]);
    // The check whose link is no web address has none.
    expect(within(rows[1]!).queryByRole("link")).toBeNull();
  });

  test("Escape closes it and gives the button the focus back", async () => {
    page(<CommitChecks repo={repo} oid={oid} state="failure" />);
    const button = screen.getByRole("button", { name: /Show checks/ });
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "Checks" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test("a click outside closes it", async () => {
    page(<CommitChecks repo={repo} oid={oid} state="failure" />);
    fireEvent.click(screen.getByRole("button", { name: /Show checks/ }));
    await screen.findByRole("dialog", { name: "Checks" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the page's own commit asks at once and shows what it is told", async () => {
    answer = { sha: oid, state: "success", statuses: [status("ci / lint", "success")] };
    // The row was drawn with nothing: the commit's checks arrived since.
    page(<CommitChecks repo={repo} oid={oid} state={null} live />);
    expect(await screen.findByRole("button", { name: "Checks passed. Show checks" })).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  test("a press inside a link's row does not follow the link", () => {
    const follow = vi.fn();
    page(
      <a href="/elsewhere" onClick={follow}>
        <CommitChecks repo={repo} oid={oid} state="success" />
      </a>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show checks/ }));
    expect(follow).not.toHaveBeenCalled();
  });

  test("a failed read says so in the box", async () => {
    setTransport(async () => {
      throw new Error("The network is away");
    });
    page(<CommitChecks repo={repo} oid={oid} state="pending" />);
    fireEvent.click(screen.getByRole("button", { name: /Show checks/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The network is away"));
  });
});

describe("where the box goes", () => {
  const viewport = { width: 1200, height: 800 };

  test("under the button", () => {
    expect(placeChecksBox({ left: 400, top: 100, bottom: 116 }, { height: 200 }, viewport)).toEqual(
      {
        left: 394,
        top: 120,
        width: 340,
      },
    );
  });

  test("inside the window at its right edge, and above when there is no room below", () => {
    const place = placeChecksBox({ left: 1180, top: 700, bottom: 716 }, { height: 200 }, viewport);
    expect(place.left + place.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(place.top).toBe(700 - 4 - 200);
  });

  test("no wider than a narrow window", () => {
    const place = placeChecksBox(
      { left: 10, top: 10, bottom: 26 },
      { height: 100 },
      { width: 320, height: 600 },
    );
    expect(place).toEqual({ left: 16, top: 30, width: 288 });
  });
});

describe("BioText", () => {
  test("links web addresses and renders everything else as text", () => {
    const { container } = render(
      <BioText text={"Hi <b>there</b> <img src=x onerror=alert(1)> https://example.test/a."} />,
    );
    // No element came from the text: one paragraph, one link.
    expect(container.querySelectorAll("b, img, script")).toHaveLength(0);
    expect(container.textContent).toBe(
      "Hi <b>there</b> <img src=x onerror=alert(1)> https://example.test/a.",
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.test/a");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
  });

  test("a javascript: address is never a link", () => {
    const { container } = render(<BioText text="javascript:alert(1) and data:text/html,x" />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  test("bidirectional controls are written out", () => {
    const { container } = render(<BioText text={"safe‮txt.exe"} />);
    expect(container.textContent).toBe("safe<U+202E>txt.exe");
  });
});
