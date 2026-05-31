import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChildResourceTable } from "../../components/detail/ChildResourceTable.js";
import type { ChildTableSchema } from "@infrawrench/plugin-base";
import type { ChildResource, ChildResourceGroup } from "../../components/detail/detail-types.js";

const spec: ChildTableSchema = {
  title: "DNS Records",
  typeId: "dns-record",
  createLabel: "+ New record",
  emptyText: "No records",
  columns: [
    { key: "name", label: "Name", source: { kind: "display-name" } },
    {
      key: "type",
      label: "Type",
      source: { kind: "field", fieldKey: "type" },
      format: "type-badge",
    },
    {
      key: "proxied",
      label: "Proxy",
      source: { kind: "field", fieldKey: "proxied" },
      format: "proxy-status",
    },
    { key: "ttl", label: "TTL", source: { kind: "field", fieldKey: "ttl" }, format: "ttl" },
  ],
  onRowClick: "navigate",
};

function child(partial: Partial<ChildResource> & { id: string }): ChildResource {
  return {
    displayName: partial.id,
    pluginId: "cf",
    resourceTypeId: "dns",
    accountId: "a1",
    ...partial,
  } as ChildResource;
}

function group(
  resources: ChildResource[],
  partial: Partial<ChildResourceGroup> = {},
): ChildResourceGroup {
  return {
    typeId: "dns",
    displayName: "record",
    pluralDisplayName: "records",
    supportsCreate: true,
    resources,
    ...partial,
  };
}

describe("ChildResourceTable", () => {
  it("renders the empty text when there are no rows", () => {
    render(<ChildResourceTable spec={spec} group={group([])} />);
    expect(screen.getByText("No records")).toBeInTheDocument();
  });

  it("renders rows with formatted cells", () => {
    const rows = [
      child({ id: "www", displayName: "www", fields: { type: "A", proxied: "true", ttl: "1" } }),
    ];
    render(<ChildResourceTable spec={spec} group={group(rows)} />);
    expect(screen.getByText("www")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("Proxied")).toBeInTheDocument();
  });

  it("invokes onRowClick when a clickable row is clicked", () => {
    const onRowClick = vi.fn();
    const rows = [child({ id: "r1", displayName: "r1", fields: { type: "A" } })];
    render(<ChildResourceTable spec={spec} group={group(rows)} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText("r1"));
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
  });

  it("shows the create button and fires onCreate", () => {
    const onCreate = vi.fn();
    render(<ChildResourceTable spec={spec} group={group([])} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "+ New record" }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("renders a delete action and calls onDelete", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const rows = [child({ id: "r1", displayName: "r1", fields: { type: "A" } })];
    render(<ChildResourceTable spec={spec} group={group(rows)} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" })),
    );
  });

  it("does not make rows clickable when onRowClick is none", () => {
    const onRowClick = vi.fn();
    const noneSpec = { ...spec, onRowClick: "none" } as ChildTableSchema;
    const rows = [child({ id: "r1", displayName: "r1", fields: { type: "A" } })];
    render(<ChildResourceTable spec={noneSpec} group={group(rows)} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText("r1"));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("applies a value map to render a muted placeholder", () => {
    const mapSpec = {
      ...spec,
      columns: [
        {
          key: "content",
          label: "Content",
          source: { kind: "field", fieldKey: "content" },
          valueMap: { "100::": "Managed by Worker" },
        },
      ],
    } as ChildTableSchema;
    const rows = [child({ id: "r1", displayName: "r1", fields: { content: "100::" } })];
    render(<ChildResourceTable spec={mapSpec} group={group(rows)} />);
    expect(screen.getByText("Managed by Worker")).toBeInTheDocument();
  });
});
