import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DiffFile } from "@infrawrench/git-contract";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildHunks, countChanges, diffLines } from "../../mock/diff";
import { CodeView } from "../CodeView";
import { DiffView } from "../DiffView";

// Links navigate through the router; these tests render components alone.
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { push: vi.fn(), replace: vi.fn() } }),
  useLocation: () => "/",
}));

afterEach(cleanup);

describe("CodeView", () => {
  const text = "first\nsecond\n\nfourth\n";

  test("one row per line, each number an anchor", () => {
    render(<CodeView text={text} language={null} label="file" />);
    const rows = within(screen.getByRole("table", { name: "file" })).getAllByRole("row");
    expect(rows).toHaveLength(4);
    const link = screen.getByRole("link", { name: "Line 2" });
    expect(link.getAttribute("href")).toBe("#L2");
    expect(link.id).toBe("L2");
    expect(rows[1]!.textContent).toBe("2second");
  });

  test("a click reports the line, a shift-click asks to extend", () => {
    const onSelectLine = vi.fn();
    render(<CodeView text={text} language={null} label="file" onSelectLine={onSelectLine} />);
    fireEvent.click(screen.getByRole("link", { name: "Line 2" }));
    fireEvent.click(screen.getByRole("link", { name: "Line 4" }), { shiftKey: true });
    expect(onSelectLine.mock.calls).toEqual([
      [2, false],
      [4, true],
    ]);
  });

  test("the selected range is marked", () => {
    render(<CodeView text={text} language={null} label="file" selected={{ start: 2, end: 3 }} />);
    const marked = within(screen.getByRole("table"))
      .getAllByRole("row")
      .map((row) => row.className.includes("bg-warning"));
    expect(marked).toEqual([false, true, true, false]);
  });
});

function fileOf(path: string, oldText: string, newText: string): DiffFile {
  const lines = diffLines(oldText, newText);
  return {
    path,
    oldPath: null,
    status: "modified",
    oldMode: "100644",
    newMode: "100644",
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
    binary: false,
    similarity: null,
    hunks: buildHunks(lines, 3),
    tooLarge: false,
    ...countChanges(lines),
  };
}

describe("DiffView", () => {
  const repo = { owner: "acme", repo: "infra" };
  const file = fileOf("notes.txt", "a\nb\nc\n", "a\nB\nc\nd\n");
  const cellsOf = (row: HTMLElement) =>
    within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);

  test("unified: old and new numbers, a mark and the text per line", () => {
    render(<DiffView repo={repo} files={[file]} headOid={"c".repeat(40)} layout="unified" />);
    const rows = within(screen.getByRole("table", { name: "Changes to notes.txt" })).getAllByRole(
      "row",
    );
    // The last row offers the lines after the change; the file may have more.
    expect(within(rows.at(-1)!).getByRole("button", { name: "Show more lines" })).toBeTruthy();
    expect(rows.slice(0, -1).map(cellsOf)).toEqual([
      ["1", "1", " a"],
      ["2", "", "Removed line-b"],
      ["", "2", "Added line+B"],
      ["3", "3", " c"],
      ["", "4", "Added line+d"],
    ]);
    expect(screen.getByText("2 additions")).toBeTruthy();
    expect(screen.getByText("1 deletion")).toBeTruthy();
  });

  test("split: a changed line sits beside what replaced it", () => {
    render(<DiffView repo={repo} files={[file]} headOid={"c".repeat(40)} layout="split" />);
    const rows = within(screen.getByRole("table", { name: "Changes to notes.txt" })).getAllByRole(
      "row",
    );
    // The last row offers the lines after the change; the file may have more.
    expect(within(rows.at(-1)!).getByRole("button", { name: "Show more lines" })).toBeTruthy();
    expect(rows.slice(0, -1).map(cellsOf)).toEqual([
      ["1", " a", "1", " a"],
      ["2", "Removed line-b", "2", "Added line+B"],
      ["3", " c", "3", " c"],
      ["", "", "4", "Added line+d"],
    ]);
  });

  test("a binary file and a file left out as too large say so", () => {
    const loadFile = vi.fn(async () => file);
    render(
      <DiffView
        repo={repo}
        files={[
          { ...file, path: "logo.png", binary: true, hunks: [] },
          { ...file, path: "big.sql", tooLarge: true, hunks: [] },
        ]}
        headOid={"c".repeat(40)}
        layout="unified"
        loadFile={loadFile}
      />,
    );
    expect(screen.getByText("Binary file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    expect(loadFile).toHaveBeenCalledWith("big.sql");
  });

  test("a file collapses to its header", () => {
    render(<DiffView repo={repo} files={[file]} headOid={"c".repeat(40)} layout="unified" />);
    fireEvent.click(screen.getByRole("button", { name: "Hide notes.txt" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Show notes.txt" })).toBeTruthy();
  });

  test("review slots: a row under a line and a control in its gutter", () => {
    render(
      <DiffView
        repo={repo}
        files={[file]}
        headOid={"c".repeat(40)}
        layout="unified"
        renderAfterLine={(_, line) => (line.newLine === 2 ? <p>thread on B</p> : null)}
        lineAction={(_, line) =>
          line.type === "add" ? <button type="button">Comment on {line.newLine}</button> : null
        }
      />,
    );
    expect(screen.getByText("thread on B")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Comment on/ })).toHaveLength(2);
  });
});
