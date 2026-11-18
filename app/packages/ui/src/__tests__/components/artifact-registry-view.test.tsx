import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ArtifactEntry } from "@infrawrench/plugin-base";
import {
  ArtifactRegistryView,
  artifactRowKeys,
} from "../../components/detail/ArtifactRegistryView.js";

const DIGEST = "sha256:0123456789abcdef0123456789abcdef";

describe("artifactRowKeys", () => {
  it("gives tags that share a digest their own keys", () => {
    const keys = artifactRowKeys([
      { name: "api", version: "latest", digest: DIGEST },
      { name: "api", version: "v2.14.0", digest: DIGEST },
    ]);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps keys unique for rows that repeat exactly", () => {
    const row: ArtifactEntry = { name: "api", tags: ["latest"], digest: DIGEST };
    const keys = artifactRowKeys([row, row, { name: "api" }, { name: "api" }]);
    expect(new Set(keys).size).toBe(4);
  });

  it("keeps a row's key when rows are appended after it", () => {
    const first: ArtifactEntry = { name: "api", version: "latest", digest: DIGEST };
    const [before] = artifactRowKeys([first]);
    const [after] = artifactRowKeys([first, { name: "web", version: "1" }]);
    expect(after).toBe(before);
  });
});

describe("ArtifactRegistryView", () => {
  it("lists every tag of one image without a duplicate-key warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onListArtifacts = vi.fn().mockResolvedValue({
      items: [
        { name: "api", version: "latest", digest: DIGEST },
        { name: "api", version: "v2.14.0", digest: DIGEST },
      ],
    });
    render(<ArtifactRegistryView capability={{}} onListArtifacts={onListArtifacts} />);
    expect(await screen.findByText("latest")).toBeInTheDocument();
    expect(screen.getByText("v2.14.0")).toBeInTheDocument();
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    error.mockRestore();
  });
});
