/**
 * Which repository may be the head of a comparison or a pull request into
 * another: the rules over rows, without a database (the loader is a map).
 */
import { describe, expect, it } from "vitest";
import type { RepositoryWithOwner } from "../../db/repositories";
import { forkNetworkRoot, inSameForkNetwork, mayProposeTo, plansPullRequest } from "../repos";

const repo = (
  id: string,
  options: {
    readonly namespaceId?: string;
    readonly visibility?: "public" | "private";
    readonly forkOfId?: string | null;
  } = {},
): RepositoryWithOwner =>
  ({
    repository: {
      id,
      namespaceId: options.namespaceId ?? `ns-${id}`,
      name: id,
      visibility: options.visibility ?? "public",
      forkOfId: options.forkOfId ?? null,
    },
    owner: { id: options.namespaceId ?? `ns-${id}`, slug: id, kind: "user" },
  }) as unknown as RepositoryWithOwner;

const loaderOf = (...rows: RepositoryWithOwner[]) => {
  const byId = new Map(rows.map((row) => [row.repository.id, row]));
  return async (id: string) => byId.get(id) ?? null;
};

describe("mayProposeTo", () => {
  it("lets a public head into any base", () => {
    expect(mayProposeTo(repo("base"), repo("fork"))).toBe(true);
    expect(mayProposeTo(repo("base", { visibility: "private" }), repo("fork"))).toBe(true);
  });

  it("keeps a private head out of a public base, whoever owns either", () => {
    const head = repo("fork", { visibility: "private", namespaceId: "acme" });
    expect(mayProposeTo(repo("base", { namespaceId: "acme" }), head)).toBe(false);
    expect(mayProposeTo(repo("base"), head)).toBe(false);
  });

  it("keeps a private head out of a private base in another namespace", () => {
    const head = repo("fork", { visibility: "private", namespaceId: "acme" });
    const base = repo("base", { visibility: "private", namespaceId: "other" });
    expect(mayProposeTo(base, head)).toBe(false);
  });

  it("lets a private head into a private base of the same namespace, and a repository into itself", () => {
    const head = repo("fork", { visibility: "private", namespaceId: "acme" });
    const base = repo("base", { visibility: "private", namespaceId: "acme" });
    expect(mayProposeTo(base, head)).toBe(true);
    expect(mayProposeTo(head, head)).toBe(true);
  });
});

describe("plansPullRequest", () => {
  it("plans a pull request from a branch of the base itself", () => {
    expect(plansPullRequest("base", "base")).toBe(true);
  });

  it("never plans a fork's pull request, or one whose fork is gone", () => {
    expect(plansPullRequest("base", "fork")).toBe(false);
    expect(plansPullRequest("base", null)).toBe(false);
  });
});

describe("fork networks", () => {
  const root = repo("root");
  const fork = repo("fork", { forkOfId: "root" });
  const forkOfFork = repo("fork-of-fork", { forkOfId: "fork" });
  const sibling = repo("sibling", { forkOfId: "root" });
  const stranger = repo("stranger");
  const load = loaderOf(root, fork, forkOfFork, sibling, stranger);

  it("finds the oldest ancestor still there", async () => {
    expect(await forkNetworkRoot(forkOfFork, load)).toBe("root");
    expect(await forkNetworkRoot(root, load)).toBe("root");
    // A parent that is gone ends the walk: the fork stands on its own.
    expect(await forkNetworkRoot(repo("orphan", { forkOfId: "deleted" }), load)).toBe("orphan");
  });

  it("puts parents, forks, forks of forks and siblings in one network", async () => {
    expect(await inSameForkNetwork(root, fork, load)).toBe(true);
    expect(await inSameForkNetwork(fork, root, load)).toBe(true);
    expect(await inSameForkNetwork(root, forkOfFork, load)).toBe(true);
    expect(await inSameForkNetwork(sibling, forkOfFork, load)).toBe(true);
  });

  it("leaves an unrelated repository out, whatever the caller can read", async () => {
    expect(await inSameForkNetwork(root, stranger, load)).toBe(false);
    expect(await inSameForkNetwork(fork, stranger, load)).toBe(false);
  });

  it("stops on a cycle rather than looping", async () => {
    const a = repo("a", { forkOfId: "b" });
    const b = repo("b", { forkOfId: "a" });
    const cyclic = loaderOf(a, b);
    expect(["a", "b"]).toContain(await forkNetworkRoot(a, cyclic));
  });
});
