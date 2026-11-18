import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SqlEditorView, initialEditorQuery } from "../../components/detail/SqlEditorView.js";

describe("initialEditorQuery", () => {
  it("opens on the plugin's starter query", () => {
    expect(initialEditorQuery({ defaultQuery: "sum by (job) (up)", queryLanguage: "PromQL" })).toBe(
      "sum by (job) (up)",
    );
    expect(initialEditorQuery({ defaultQuery: "SHOW TABLES" })).toBe("SHOW TABLES");
  });

  it("starts a SQL editor without one on SELECT 1", () => {
    expect(initialEditorQuery({})).toBe("SELECT 1;");
  });

  it("starts an editor for another language empty, not on SQL", () => {
    expect(initialEditorQuery({ queryLanguage: "InfluxQL" })).toBe("");
  });
});

describe("SqlEditorView", () => {
  it("names the language and runs nothing when it opens empty", async () => {
    const onRunQuery = vi.fn(async () => ({ rows: [], durationMs: 1 }));
    render(
      <SqlEditorView tables={[]} defaultQuery="" queryLanguage="DQL" onRunQuery={onRunQuery} />,
    );
    const editor = screen.getByLabelText("DQL query") as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    expect(editor.placeholder).toBe("");
    // Give the mount effect its chance to run a query.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRunQuery).not.toHaveBeenCalled();
  });

  it("keeps the SQL label and example for a SQL editor, and runs its starter", async () => {
    const onRunQuery = vi.fn(async () => ({ rows: [], durationMs: 1 }));
    render(<SqlEditorView tables={[]} defaultQuery="SELECT 1;" onRunQuery={onRunQuery} />);
    const editor = screen.getByLabelText("SQL query") as HTMLTextAreaElement;
    expect(editor.placeholder).toBe("SELECT …");
    await waitFor(() => expect(onRunQuery).toHaveBeenCalledWith("SELECT 1;"));
  });
});
