import { describe, expect, it } from "vitest";
import { MAX_SSH_HOPS, resolveSshChain, type SshAccountConfig } from "../chain.js";

function makeLoader(graph: Record<string, SshAccountConfig>) {
  return async (id: string): Promise<SshAccountConfig> => {
    const cfg = graph[id];
    if (!cfg) throw new Error(`missing account ${id}`);
    return cfg;
  };
}

describe("resolveSshChain", () => {
  it("returns a single hop when there is no jumpbox", async () => {
    const hops = await resolveSshChain(
      "target",
      makeLoader({
        target: { host: "10.0.0.1", port: 22, username: "root", privateKey: "k" },
      }),
    );
    expect(hops).toEqual([{ host: "10.0.0.1", port: 22, username: "root", privateKey: "k" }]);
  });

  it("returns hops outermost-first for a two-hop chain", async () => {
    const hops = await resolveSshChain(
      "target",
      makeLoader({
        target: {
          host: "10.0.0.2",
          port: 22,
          username: "u",
          privateKey: "kT",
          connectThroughAccountId: "jump",
        },
        jump: { host: "edge.example.com", port: 22, username: "j", privateKey: "kJ" },
      }),
    );
    expect(hops.map((h) => h.host)).toEqual(["edge.example.com", "10.0.0.2"]);
    expect(hops[0]?.privateKey).toBe("kJ");
    expect(hops[1]?.privateKey).toBe("kT");
  });

  it("walks a three-hop chain in the correct order", async () => {
    const hops = await resolveSshChain(
      "target",
      makeLoader({
        target: {
          host: "T",
          port: 22,
          username: "u",
          privateKey: "kT",
          connectThroughAccountId: "mid",
        },
        mid: {
          host: "M",
          port: 22,
          username: "u",
          privateKey: "kM",
          connectThroughAccountId: "edge",
        },
        edge: { host: "E", port: 22, username: "u", privateKey: "kE" },
      }),
    );
    expect(hops.map((h) => h.host)).toEqual(["E", "M", "T"]);
  });

  it("throws on cycles", async () => {
    await expect(
      resolveSshChain(
        "a",
        makeLoader({
          a: { host: "A", port: 22, username: "u", privateKey: "k", connectThroughAccountId: "b" },
          b: { host: "B", port: 22, username: "u", privateKey: "k", connectThroughAccountId: "a" },
        }),
      ),
    ).rejects.toThrow(/cycle/i);
  });

  it("enforces the hop cap", async () => {
    const graph: Record<string, SshAccountConfig> = {};
    // Build a chain of MAX_SSH_HOPS + 2 accounts: id0 -> id1 -> ... -> idN.
    const total = MAX_SSH_HOPS + 2;
    for (let i = 0; i < total; i++) {
      graph[`id${i}`] = {
        host: `h${i}`,
        port: 22,
        username: "u",
        privateKey: "k",
        ...(i < total - 1 ? { connectThroughAccountId: `id${i + 1}` } : {}),
      };
    }
    await expect(resolveSshChain("id0", makeLoader(graph))).rejects.toThrow(/maximum/i);
  });

  it("treats an empty connectThroughAccountId as no jumpbox", async () => {
    const hops = await resolveSshChain(
      "target",
      makeLoader({
        target: {
          host: "T",
          port: 22,
          username: "u",
          privateKey: "k",
          connectThroughAccountId: "",
        },
      }),
    );
    expect(hops).toHaveLength(1);
  });
});
