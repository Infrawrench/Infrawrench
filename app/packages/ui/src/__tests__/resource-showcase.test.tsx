import { existsSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { render, screen } from "@testing-library/react";
import {
  buildResourceShowcase,
  showcaseFields,
  type ShowcaseField,
} from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { TileFrame } from "../dnd/TileFrame.js";

interface RegistryType {
  id: string;
  fields: Array<{
    key: string;
    label: string;
    kind: string;
    required: boolean;
    showcase?: boolean;
  }>;
  outputs: Array<{ key: string; sensitive: boolean }>;
}

function registryPath(): string {
  let dir = cwd();
  for (let up = 0; up < 10; up++) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) {
      return `${dir}/app/packages/server-core/src/plugin-registry-edge.gen.json`;
    }
    dir = `${dir}/..`;
  }
  throw new Error("workspace root not found");
}

const registry = JSON.parse(readFileSync(registryPath(), "utf8")) as {
  plugins: Array<{ resourceTypes: RegistryType[] }>;
};
const plugins = registry.plugins;
const types = plugins.flatMap((p) => p.resourceTypes);

describe("the plugin registry's showcases", () => {
  it("never marks a secret", () => {
    const offenders = types.flatMap((type) =>
      type.fields.flatMap((field) =>
        field.showcase &&
        (field.kind === "secret" ||
          field.kind === "password" ||
          type.outputs.some((o) => o.sensitive && o.key === field.key))
          ? [`${type.id}.${field.key}`]
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("marks fields on most types, so tiles aren't blank by default", () => {
    const marked = types.filter((type) => showcaseFields(type as never).length > 0);
    expect(marked.length / types.length).toBeGreaterThan(0.8);
  });
});

const FIELDS: ShowcaseField[] = [
  { key: "status", label: "Status" },
  { key: "vcpus", label: "vCPU" },
  { key: "memoryMb", label: "Memory (MB)" },
  { key: "region", label: "Region" },
];

describe("a tile's showcase", () => {
  it("drops a label's unit once the value carries it", () => {
    render(<TileFrame name="vm" showcase={buildResourceShowcase({ memoryMb: 2048 }, FIELDS)} />);
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("2 GB")).toBeTruthy();
  });

  it("draws the status line and rows", () => {
    render(
      <TileFrame
        name="web-1"
        showcase={buildResourceShowcase({ status: "active", vcpus: 2, region: "nyc3" }, FIELDS)}
      />,
    );
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("vCPU")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.getByText("nyc3")).toBeTruthy();
  });

  it("colours the status dot from the word", () => {
    const { container } = render(
      <TileFrame name="db" showcase={buildResourceShowcase({ status: "failed" }, FIELDS)} />,
    );
    expect(container.querySelector(".bg-danger")).toBeTruthy();
  });

  it("gives a long name more room when there are no rows", () => {
    const { container } = render(
      <TileFrame name="x" showcase={buildResourceShowcase({}, FIELDS)} />,
    );
    expect(container.querySelector(".line-clamp-3")).toBeTruthy();
  });
});
