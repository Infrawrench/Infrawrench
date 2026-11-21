import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  SqlEditorView,
  initialEditorQuery,
  tableBrowseQuery,
} from "../../components/detail/SqlEditorView.js";

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

describe("tableBrowseQuery", () => {
  it("browses a table in a SQL editor with SELECT", () => {
    expect(tableBrowseQuery({}, "users")).toBe("SELECT * FROM users LIMIT 100;");
  });

  it("fills every {table} in the plugin's own query", () => {
    expect(
      tableBrowseQuery({ queryLanguage: "DQL", tableQuery: "fetch {table}\n| limit 100" }, "logs"),
    ).toBe("fetch logs\n| limit 100");
    expect(tableBrowseQuery({ tableQuery: "SELECT count(*) FROM {table}; -- {table}" }, "t")).toBe(
      "SELECT count(*) FROM t; -- t",
    );
  });

  it("gives an editor for another language without one nothing to run", () => {
    expect(tableBrowseQuery({ queryLanguage: "PromQL" }, "up")).toBeNull();
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

  it("runs nothing when a table is clicked in another language without a table query", async () => {
    const onRunQuery = vi.fn(async () => ({ rows: [], durationMs: 1 }));
    render(
      <SqlEditorView
        tables={[{ name: "logs", columns: [] }]}
        defaultQuery=""
        queryLanguage="DQL"
        onRunQuery={onRunQuery}
      />,
    );
    expect(screen.queryByRole("button", { name: "logs" })).toBeNull();
    fireEvent.click(screen.getByText("logs"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((screen.getByLabelText("DQL query") as HTMLTextAreaElement).value).toBe("");
    expect(onRunQuery).not.toHaveBeenCalled();
  });

  it("inserts and runs the plugin's table query when a table is clicked", async () => {
    const onRunQuery = vi.fn(async () => ({ rows: [], durationMs: 1 }));
    render(
      <SqlEditorView
        tables={[{ name: "logs", columns: [] }]}
        defaultQuery=""
        queryLanguage="DQL"
        tableQuery={"fetch {table}\n| limit 100"}
        onRunQuery={onRunQuery}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "logs" }));
    expect((screen.getByLabelText("DQL query") as HTMLTextAreaElement).value).toBe(
      "fetch logs\n| limit 100",
    );
    await waitFor(() => expect(onRunQuery).toHaveBeenCalledWith("fetch logs\n| limit 100"));
  });
});
