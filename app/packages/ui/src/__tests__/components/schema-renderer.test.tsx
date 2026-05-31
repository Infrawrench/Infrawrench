import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SchemaRenderer, StatusDotNodeRenderer } from "../../components/renderer/SchemaRenderer.js";
import {
  NAVIGATE_TO_RESOURCE_EVENT,
  REFRESH_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  REROLL_PARENT_OUTPUT_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
} from "../../utils.js";
import { useUIStore } from "../../store/ui.store.js";

describe("SchemaRenderer", () => {
  it("renders a text body node as a paragraph", () => {
    render(<SchemaRenderer node={{ kind: "text", content: "Hello world" }} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders a heading text variant", () => {
    render(<SchemaRenderer node={{ kind: "text", content: "Title", variant: "heading" }} />);
    const el = screen.getByText("Title");
    expect(el.className).toContain("font-semibold");
  });

  it("renders a copyable mono text node with a copy button", () => {
    render(
      <SchemaRenderer
        node={{ kind: "text", content: "cfg-line", variant: "mono", copyable: true }}
      />,
    );
    expect(screen.getByText("cfg-line")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("renders a non-copyable mono text node without a copy button", () => {
    render(<SchemaRenderer node={{ kind: "text", content: "x", variant: "mono" }} />);
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("renders a badge node with the label", () => {
    render(<SchemaRenderer node={{ kind: "badge", label: "Active", color: "green" }} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("falls back to gray for an unknown badge color", () => {
    render(<SchemaRenderer node={{ kind: "badge", label: "X", color: "magenta" as never }} />);
    expect(screen.getByText("X")).toBeInTheDocument();
  });

  it("renders a status-dot node with a label", () => {
    render(<SchemaRenderer node={{ kind: "status-dot", status: "healthy", label: "Up" }} />);
    expect(screen.getByText("Up")).toBeInTheDocument();
  });

  it("StatusDotNodeRenderer handles an unknown status without a label", () => {
    const { container } = render(
      <StatusDotNodeRenderer node={{ kind: "status-dot", status: "weird" as never }} />,
    );
    expect(container.querySelector("span")).toBeTruthy();
  });

  it("renders a link node with href and target", () => {
    render(<SchemaRenderer node={{ kind: "link", label: "Docs", url: "https://example.com" }} />);
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders a section node with title and children", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "section",
          title: "Details",
          children: [{ kind: "text", content: "child-text" }],
        }}
      />,
    );
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("child-text")).toBeInTheDocument();
  });

  it("renders a grid node with multiple items", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "grid",
          columns: 3,
          items: [
            { kind: "text", content: "a" },
            { kind: "text", content: "b" },
          ],
        }}
      />,
    );
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("renders a key-value list including a string item", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "key-value-list",
          items: [{ key: "Region", value: "nyc1" }],
        }}
      />,
    );
    expect(screen.getByText("Region")).toBeInTheDocument();
    expect(screen.getByText("nyc1")).toBeInTheDocument();
  });

  it("shows a copy button for a copyable kv string item", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "key-value-list",
          items: [{ key: "Token", value: "abc", copyable: true }],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("renders a table node with rows", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "table",
          columns: [
            { key: "name", label: "Name" },
            { key: "size", label: "Size", width: "narrow", mono: true },
          ],
          rows: [{ cells: { name: "db-1", size: "10GB" } }],
          emphasizeFirstColumn: true,
        }}
      />,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("db-1")).toBeInTheDocument();
    expect(screen.getByText("10GB")).toBeInTheDocument();
  });

  it("renders an empty table with a No rows message", () => {
    render(
      <SchemaRenderer node={{ kind: "table", columns: [{ key: "a", label: "A" }], rows: [] }} />,
    );
    expect(screen.getByText("No rows")).toBeInTheDocument();
  });

  it("renders an action cell inside a table", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "table",
          columns: [{ key: "act", label: "Action" }],
          rows: [
            {
              cells: {
                act: { kind: "action", label: "Go", action: { type: "refresh-resource" } },
              },
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });

  it("returns null for an unknown node kind", () => {
    const { container } = render(<SchemaRenderer node={{ kind: "totally-unknown" } as never} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SchemaRenderer action dispatch", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it("open-url action calls window.open", () => {
    render(
      <SchemaRenderer
        node={{
          kind: "action",
          label: "Open",
          action: { type: "open-url", url: "https://x.test" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openSpy).toHaveBeenCalledWith("https://x.test", "_blank", "noopener,noreferrer");
  });

  it("navigate-to-resource action dispatches the navigation event", () => {
    const listener = vi.fn();
    window.addEventListener(NAVIGATE_TO_RESOURCE_EVENT, listener);
    render(
      <SchemaRenderer
        node={{
          kind: "action",
          label: "Nav",
          action: {
            type: "navigate-to-resource",
            pluginId: "p",
            resourceTypeId: "rt",
            resourceId: "r",
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Nav" }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(NAVIGATE_TO_RESOURCE_EVENT, listener);
  });

  it("refresh-resource action dispatches the refresh event", () => {
    const listener = vi.fn();
    window.addEventListener(REFRESH_RESOURCE_EVENT, listener);
    render(
      <SchemaRenderer
        node={{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(REFRESH_RESOURCE_EVENT, listener);
  });

  it("plugin-action dispatches the invoke event with resourceId", () => {
    const listener = vi.fn();
    window.addEventListener(INVOKE_PLUGIN_ACTION_EVENT, listener as EventListener);
    render(
      <SchemaRenderer
        resourceId="res-1"
        node={{
          kind: "action",
          label: "Run",
          variant: "danger",
          action: { type: "plugin-action", actionId: "do-it", confirmMessage: "sure?" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(listener).toHaveBeenCalledOnce();
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({ actionId: "do-it", resourceId: "res-1" });
    window.removeEventListener(INVOKE_PLUGIN_ACTION_EVENT, listener as EventListener);
  });

  it("reroll-parent-output dispatches the reroll event", () => {
    const listener = vi.fn();
    window.addEventListener(REROLL_PARENT_OUTPUT_EVENT, listener as EventListener);
    render(
      <SchemaRenderer
        node={{
          kind: "action",
          label: "Reroll",
          action: { type: "reroll-parent-output", outputKey: "pw" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reroll" }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(REROLL_PARENT_OUTPUT_EVENT, listener as EventListener);
  });

  it("prompt-nosql-command dispatches the prompt event", () => {
    const listener = vi.fn();
    window.addEventListener(PROMPT_NOSQL_COMMAND_EVENT, listener as EventListener);
    render(
      <SchemaRenderer
        node={{
          kind: "action",
          label: "Cmd",
          action: {
            type: "prompt-nosql-command",
            command: "deleteOne",
            fields: [],
            title: "Delete",
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cmd" }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(PROMPT_NOSQL_COMMAND_EVENT, listener as EventListener);
  });

  it("reroll-secret kv item opens the reroll field in the store", () => {
    useUIStore.setState({ rerollingField: null });
    render(
      <SchemaRenderer
        resourceId="db-9"
        node={{
          kind: "key-value-list",
          items: [
            {
              key: "Password",
              value: {
                kind: "secret-placeholder",
                fieldKey: "password",
                resolution: { kind: "generated" },
              } as never,
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reroll" }));
    expect(useUIStore.getState().rerollingField).toEqual({
      resourceId: "db-9",
      fieldKey: "password",
    });
  });
});
