import { Context, Schema } from "effect";
import { HttpApi, OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";
import {
  AgentLinkSet,
  AllowedWhenArchived,
  Authentication,
  Diff,
  FORGE_LIMITS,
  GitApi,
  HandlerGate,
  RepositoryAccess,
  RequiredAccess,
  RequiredOrgPermission,
  RequiresUser,
  Session,
  T3Models,
  TimelineItem,
  accessAtLeast,
  archivePath,
  httpCloneUrl,
  isValidRefName,
  namespaceSlugProblem,
  privateRepositoryRefusal,
  rawPath,
  repositoryNameProblem,
  sshCloneUrl,
  suggestSlug,
} from "../index";

interface Listed {
  readonly group: string;
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly annotations: Context.Context<never>;
  readonly middleware: ReadonlySet<unknown>;
}

const endpoints: Listed[] = [];
HttpApi.reflect(GitApi, {
  onGroup: () => {},
  onEndpoint: ({ group, endpoint, mergedAnnotations, middleware }) => {
    endpoints.push({
      group: group.identifier,
      name: endpoint.identifier,
      method: endpoint.method,
      path: endpoint.path,
      annotations: mergedAnnotations,
      middleware,
    });
  },
});

const REPO_PREFIX = "/api/repos/:owner/:repo";

/** Endpoints anyone may call with nothing: the session probe and the public reads. */
const OPEN = new Set([
  "session.me",
  "session.signOut",
  "namespaces.get",
  "repositoryLists.listForNamespace",
  "repositoryLists.listStarredBy",
  "repositoryLists.explore",
]);

/**
 * Writes a CI job's token makes with the `read` it has: the handler takes a
 * person with `write` or the job, and refuses everyone else.
 */
const JOB_WRITES = new Set(["traces.record"]);

describe("GitApi", () => {
  it("has every group's endpoints", () => {
    expect(endpoints.length).toBeGreaterThan(100);
  });

  it("routes each method and path once", () => {
    const seen = new Map<string, string>();
    for (const e of endpoints) {
      const key = `${e.method} ${e.path.replace(/:[A-Za-z]+/g, ":p")}`;
      expect(seen.get(key), `${key} is both ${seen.get(key)} and ${e.group}.${e.name}`).toBe(
        undefined,
      );
      seen.set(key, `${e.group}.${e.name}`);
    }
  });

  it("puts everything under /api", () => {
    for (const e of endpoints) expect(e.path.startsWith("/api/")).toBe(true);
  });

  it("authenticates every endpoint", () => {
    for (const e of endpoints) {
      expect(e.middleware.has(Authentication), `${e.group}.${e.name}`).toBe(true);
    }
  });

  it("gates every repository endpoint on an access level", () => {
    for (const e of endpoints) {
      const id = `${e.group}.${e.name}`;
      const inRepo = e.path.startsWith(REPO_PREFIX);
      expect(e.middleware.has(RepositoryAccess), id).toBe(inRepo);
      const access = Context.get(e.annotations, RequiredAccess);
      if (inRepo) expect(access, id).not.toBe(undefined);
      else expect(access, id).toBe(undefined);
    }
  });

  it("states a gate on everything that is not an open read", () => {
    for (const e of endpoints) {
      const id = `${e.group}.${e.name}`;
      if (e.path.startsWith(REPO_PREFIX)) continue;
      const gated =
        Context.get(e.annotations, RequiresUser) ||
        Context.get(e.annotations, RequiredOrgPermission) !== undefined;
      expect(gated, id).toBe(!OPEN.has(id));
    }
  });

  it("needs a signed-in person for every write that only asks for read access", () => {
    for (const e of endpoints) {
      if (e.method === "GET" || !e.path.startsWith(REPO_PREFIX)) continue;
      if (Context.get(e.annotations, RequiredAccess) !== "read") continue;
      if (JOB_WRITES.has(`${e.group}.${e.name}`)) continue;
      expect(Context.get(e.annotations, RequiresUser), `${e.group}.${e.name}`).toBe(true);
    }
  });

  it("keeps an archived repository's settings readable and its way out open", () => {
    const allowed = endpoints
      .filter((e) => Context.get(e.annotations, AllowedWhenArchived))
      .map((e) => `${e.group}.${e.name}`);
    for (const e of endpoints) {
      const id = `${e.group}.${e.name}`;
      if (!Context.get(e.annotations, AllowedWhenArchived)) continue;
      expect(Context.get(e.annotations, RequiredAccess), id).toBe("admin");
    }
    for (const e of endpoints) {
      if (e.method !== "GET" || Context.get(e.annotations, RequiredAccess) !== "admin") continue;
      expect(allowed).toContain(`${e.group}.${e.name}`);
    }
    expect(allowed).toContain("repositories.update");
    expect(allowed).toContain("repositories.delete");
  });

  it("only documents a handler gate beside an enforced one", () => {
    for (const e of endpoints) {
      if (Context.get(e.annotations, HandlerGate) === undefined) continue;
      expect(Context.get(e.annotations, RequiresUser), `${e.group}.${e.name}`).toBe(true);
    }
  });

  it("tells a repository's name to nobody its creation would not", () => {
    const gate = (id: string) => {
      const found = endpoints.find((e) => `${e.group}.${e.name}` === id);
      expect(found, id).toBeDefined();
      return found!;
    };
    const create = gate("repositoryLists.nameAvailability");
    expect(create.method).toBe("GET");
    expect(Context.get(create.annotations, RequiresUser)).toBe(true);
    expect(Context.get(create.annotations, HandlerGate)).toMatch(/git:write/);
    expect(Context.get(gate("repositories.renameAvailability").annotations, RequiredAccess)).toBe(
      Context.get(gate("repositories.rename").annotations, RequiredAccess),
    );
  });

  it("leaves a repository's CI switch to its administrators", () => {
    for (const name of ["settings", "updateSettings"]) {
      const found = endpoints.find((e) => e.group === "ci" && e.name === name);
      expect(Context.get(found!.annotations, RequiredAccess), name).toBe("admin");
    }
  });

  it("defines agent work review whole, for the handlers that come later", () => {
    const ids = new Set(endpoints.map((e) => `${e.group}.${e.name}`));
    for (const id of [
      "versions.list",
      "versions.diff",
      "versions.markReviewed",
      "versions.branchState",
      "review.inbox",
      "traces.record",
      "findings.dismiss",
      "findings.override",
      "findings.requestRun",
      "instructions.send",
      "instructions.markAnswered",
      "agents.startWork",
      "agents.set",
      "t3.beginOAuth",
      "t3.listModels",
      "reviewSettings.update",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    const gate = (id: string) =>
      Context.get(
        endpoints.find((e) => `${e.group}.${e.name}` === id)!.annotations,
        RequiredAccess,
      );
    // Overriding the merge block is an administrator's, and so are the settings.
    expect(gate("findings.override")).toBe("admin");
    expect(gate("reviewSettings.update")).toBe("admin");
    expect(gate("agents.startWork")).toBe("write");
  });

  it("builds an OpenAPI document", () => {
    const spec = OpenApi.fromApi(GitApi);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(60);
    expect(spec.paths["/api/repos/{owner}/{repo}/branches/{branch}/merge"]?.post).toBeDefined();
  });
});

describe("plan limits", () => {
  it("refuses one more private repository with the plan's own numbers", () => {
    expect(privateRepositoryRefusal("paid", 10_000)).toBeNull();
    expect(privateRepositoryRefusal("free", FORGE_LIMITS.free.privateRepositories! - 1)).toBeNull();
    expect(privateRepositoryRefusal("free", FORGE_LIMITS.free.privateRepositories!)).toContain(
      `${FORGE_LIMITS.free.privateRepositories} private repositories`,
    );
    expect(
      privateRepositoryRefusal("personal", FORGE_LIMITS.personal.privateRepositories!),
    ).toContain("personal namespace");
  });

  it("carries the form's defaults on the session", () => {
    const session = Schema.decodeSync(Session)({
      user: null,
      onboarding: null,
      personal: {
        privateRepositories: false,
        privateRepositoryRefusal: "A personal namespace includes 5 private repositories",
        defaultVisibility: "private",
        workspace: { id: "org", name: "Acme" },
      },
      organizations: [
        {
          id: "org",
          name: "Acme",
          namespace: "acme",
          permissions: ["git:write"],
          namespacePlanRefusal: null,
          canClaimNamespace: false,
          paid: true,
          privateRepositories: true,
          privateRepositoryRefusal: null,
          defaultVisibility: "public",
        },
      ],
      signInUrl: "/auth/sign-in",
      appUrl: "https://app.example.test",
      sshEnabled: true,
      reservedNamesAllowed: false,
    });
    expect(session.organizations[0]?.defaultVisibility).toBe("public");
    expect(session.personal?.privateRepositories).toBe(false);
  });
});

describe("schemas", () => {
  it("decodes a diff as the UI renders it", () => {
    const oid = "a".repeat(40);
    const diff = Schema.decodeSync(Diff)({
      baseOid: null,
      headOid: oid,
      stats: { filesChanged: 1, additions: 1, deletions: 1 },
      nextCursor: null,
      files: [
        {
          path: "a.txt",
          oldPath: null,
          status: "modified",
          oldMode: "100644",
          newMode: "100644",
          oldOid: oid,
          newOid: oid,
          binary: false,
          additions: 1,
          deletions: 1,
          similarity: null,
          tooLarge: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              section: "",
              lines: [
                { type: "context", content: "one", oldLine: 1, newLine: 1 },
                { type: "delete", content: "two", oldLine: 2, newLine: null },
                {
                  type: "add",
                  content: "2",
                  oldLine: null,
                  newLine: 2,
                  noNewlineAtEnd: true,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(diff.files[0]?.hunks[0]?.lines).toHaveLength(3);
  });

  it("tells timeline entries apart by type", () => {
    const decode = Schema.decodeUnknownSync(TimelineItem);
    const entry = decode({
      type: "renamed",
      id: "1",
      actor: null,
      createdAt: "2026-11-25T00:00:00.000Z",
      from: "a",
      to: "b",
    });
    expect(entry.type).toBe("renamed");
    expect(() => decode({ type: "renamed", id: "1" })).toThrow();
  });
});

describe("the model a T3 Code thread runs", () => {
  it("lists an environment's models for a signed-in person, like its threads", () => {
    const find = (name: string) => endpoints.find((e) => e.group === "t3" && e.name === name)!;
    const models = find("listModels");
    expect(models).toMatchObject({
      method: "GET",
      path: "/api/t3/environments/:environmentId/models",
    });
    expect(Context.get(models.annotations, RequiresUser)).toBe(true);
    expect(models.middleware).toEqual(find("listThreads").middleware);
  });

  it("takes a chosen model with the agent, and refuses one that names nothing", () => {
    const decode = Schema.decodeUnknownSync(AgentLinkSet);
    const agent = { kind: "t3", displayName: "T3 Code", t3EnvironmentId: "env-1" };
    // Nothing chosen is still an agent: the forge finds a model itself.
    expect(decode(agent).t3Model).toBeUndefined();
    expect(
      decode({
        ...agent,
        t3Model: {
          providerId: "claudeAgent",
          model: "claude-opus-5-5",
          reasoning: { optionId: "effort", level: "high" },
        },
      }).t3Model,
    ).toEqual({
      providerId: "claudeAgent",
      model: "claude-opus-5-5",
      reasoning: { optionId: "effort", level: "high" },
    });
    expect(decode({ ...agent, t3Model: { providerId: "codex", model: "m" } }).t3Model).toEqual({
      providerId: "codex",
      model: "m",
    });
    expect(() => decode({ ...agent, t3Model: { providerId: "", model: "m" } })).toThrow();
    expect(() => decode({ ...agent, t3Model: { providerId: "codex" } })).toThrow();
    expect(() =>
      decode({ ...agent, t3Model: { providerId: "codex", model: "m".repeat(201) } }),
    ).toThrow();
  });

  it("answers models with their reasoning levels, or none", () => {
    const models = Schema.decodeSync(T3Models)({
      providers: [
        {
          id: "claudeAgent",
          name: "Claude",
          models: [
            {
              id: "claude-opus-5-5",
              label: "Claude Opus 5.5",
              reasoning: { optionId: "effort", levels: ["low", "high"], default: "high" },
            },
            { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", reasoning: null },
          ],
        },
      ],
      default: null,
    });
    expect(models.providers[0]?.models.map((each) => each.reasoning?.levels ?? null)).toEqual([
      ["low", "high"],
      null,
    ]);
  });
});

describe("names", () => {
  it("accepts ordinary slugs", () => {
    for (const ok of ["acme", "Acme-Corp", "a.b", "x_1", "9lives", "_private"]) {
      expect(namespaceSlugProblem(ok), ok).toBe(null);
    }
  });

  it("refuses what the README rules out", () => {
    expect(namespaceSlugProblem("")).toBe("empty");
    expect(namespaceSlugProblem(".hidden")).toBe("characters");
    expect(namespaceSlugProblem("-dash")).toBe("characters");
    expect(namespaceSlugProblem("has space")).toBe("characters");
    expect(namespaceSlugProblem("repo.git")).toBe("git_suffix");
    expect(namespaceSlugProblem("Repo.GIT")).toBe("git_suffix");
    expect(namespaceSlugProblem("a..b")).toBe("dots");
    expect(namespaceSlugProblem("API")).toBe("reserved");
    expect(namespaceSlugProblem("explore")).toBe("reserved");
    expect(namespaceSlugProblem("a".repeat(40))).toBe("too_long");
    expect(repositoryNameProblem("settings")).toBe("reserved");
    expect(repositoryNameProblem("infra")).toBe(null);
  });

  it("suggests a slug the rules accept", () => {
    expect(suggestSlug("Astrid.Example+git@example.com")).toBe("Astrid.Example-git");
    expect(suggestSlug("...@example.com")).toBe("");
    const long = suggestSlug(`${"a".repeat(60)}@example.com`);
    expect(namespaceSlugProblem(long)).toBe(null);
  });

  it("checks ref names", () => {
    for (const ok of ["main", "feature/x", "release-1.2", "user/a_b"]) {
      expect(isValidRefName(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "-x",
      "a..b",
      "a b",
      "a.lock",
      "a/",
      "/a",
      "a//b",
      "HEAD",
      "a~1",
      "a:b",
      ".a",
      "a/.b",
      "a@{1}",
    ]) {
      expect(isValidRefName(bad), bad).toBe(false);
    }
  });
});

describe("urls", () => {
  const ref = { owner: "acme", repo: "infra" };

  it("builds clone URLs", () => {
    expect(httpCloneUrl(ref)).toBe("https://git.infrawrench.com/acme/infra.git");
    expect(sshCloneUrl(ref)).toBe("git@git.infrawrench.com:acme/infra.git");
  });

  it("names the configured SSH host, with its port when it has one", () => {
    expect(sshCloneUrl(ref, "ssh.git.infrawrench.com")).toBe(
      "git@ssh.git.infrawrench.com:acme/infra.git",
    );
    expect(sshCloneUrl(ref, "127.0.0.1:8788")).toBe("ssh://git@127.0.0.1:8788/acme/infra.git");
  });

  it("keeps slashes in refs and paths, and escapes the rest", () => {
    expect(rawPath(ref, "feature/x", "docs/a b.md")).toBe(
      "/acme/infra/raw/feature/x/docs/a%20b.md",
    );
    expect(archivePath(ref, "v1.0", "tar.gz")).toBe("/acme/infra/archive/v1.0.tar.gz");
    expect(archivePath(ref, "main", "zip", { path: "modules/vpc" })).toBe(
      "/acme/infra/archive/main.zip?path=modules%2Fvpc",
    );
  });

  it("orders access levels", () => {
    expect(accessAtLeast("write", "triage")).toBe(true);
    expect(accessAtLeast("read", "triage")).toBe(false);
    expect(accessAtLeast("none", "read")).toBe(false);
  });
});
