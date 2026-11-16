import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit rows land here instead of a database.
const audited: Array<Record<string, unknown>> = [];
vi.mock("../../db/client.js", () => ({
  db: {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        audited.push(...rows);
        return Promise.resolve();
      },
    }),
  },
}));

const {
  GIT_CONFIG_PATH,
  githubTokenEntry,
  githubTokenKey,
  githubTokenRequests,
  lendGithubTokens,
  missingPermissions,
} = await import("../github-token");
const { mintRepositoryToken } = await import("../../github/app");
const { accessFrom } = await import("../concurrency");

// Obviously fake, and in no real token format.
const TOKEN = "installation-token-for-tests";
const EXPIRES = "2026-11-15T13:00:00Z";

const run = {
  id: "run-1",
  organizationId: "org-1",
  installationId: 42,
  repoFullName: "acme/web",
  headRef: "main",
  fromFork: false,
};

const job = (key: string, githubToken?: Record<string, string>) => ({
  pipeline: ".infrawrench/ci/release.yml",
  job: key,
  ...(githubToken ? { githubToken } : {}),
});

/** A fake GitHub: what the installation was granted, and every mint asked of it. */
function fakeGithub(granted: Record<string, string> | null) {
  const mints: Array<{ installationId: number; repository: string; permissions: unknown }> = [];
  return {
    mints,
    deps: {
      installationPermissions: async () => granted,
      mint: async (installationId: number, repository: string, permissions: unknown) => {
        mints.push({ installationId, repository, permissions });
        return { token: TOKEN, expiresAt: EXPIRES };
      },
    },
  };
}

/** Every text of a value, split into what is shown and what is masked. */
function parts(value: string | Array<{ text: string } | { secret: string }>) {
  const list = typeof value === "string" ? [{ secret: value }] : value;
  return {
    shown: list.flatMap((p) => ("text" in p ? [p.text] : [])).join(""),
    masked: list.flatMap((p) => ("secret" in p ? [p.secret] : [])),
  };
}

beforeEach(() => {
  audited.length = 0;
});

describe("which tokens a run asks for", () => {
  it("keys each set of permissions as the runner does, so jobs asking alike share one", () => {
    expect(githubTokenKey({ "pull-requests": "write", contents: "write" })).toBe(
      "contents=write,pull-requests=write",
    );
    const requests = githubTokenRequests([
      job("release", { contents: "write", "pull-requests": "write" }),
      job("notes", { "pull-requests": "write", contents: "write" }),
      job("triage", { issues: "write" }),
      job("test"),
    ]);
    expect([...requests.keys()]).toEqual(["contents=write,pull-requests=write", "issues=write"]);
    expect(githubTokenRequests(null).size).toBe(0);
  });

  it("reads `github-token` from the runners' answer, leniently", () => {
    const access = accessFrom({
      pipelines: [
        {
          file: "release.yml",
          jobs: [
            { key: "release", "github-token": { contents: "write", issues: 3 } },
            { key: "plain", "github-token": "write" },
          ],
        },
      ],
    });
    expect(access).toEqual([
      { pipeline: "release.yml", job: "release", githubToken: { contents: "write" } },
      { pipeline: "release.yml", job: "plain" },
    ]);
  });
});

describe("lendGithubTokens", () => {
  it("mints for the run's own repository and exactly the permissions asked, in GitHub's names", async () => {
    const github = fakeGithub({ contents: "write", pull_requests: "write", issues: "read" });
    const lent = await lendGithubTokens(
      run,
      [job("release", { contents: "write", "pull-requests": "write" })],
      github.deps,
    );
    expect(github.mints).toEqual([
      {
        installationId: 42,
        repository: "web",
        permissions: { contents: "write", pull_requests: "write" },
      },
    ]);
    expect(Object.keys(lent ?? {})).toEqual(["contents=write,pull-requests=write"]);
    // Audited against the installation, naming the run and what it got,
    // never the token.
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      organizationId: "org-1",
      action: "ci.lend",
      entityType: "github_installation",
      entityId: "42",
      metadata: {
        runId: "run-1",
        kind: "github-token",
        name: "contents=write,pull-requests=write",
      },
    });
    expect(JSON.stringify(audited)).not.toContain(TOKEN);
  });

  it("lends nothing to a fork's pull request, and never asks GitHub", async () => {
    const github = fakeGithub({ contents: "write" });
    expect(
      await lendGithubTokens(
        { ...run, fromFork: true },
        [job("release", { contents: "write" })],
        github.deps,
      ),
    ).toBeNull();
    expect(github.mints).toEqual([]);
    expect(await lendGithubTokens(run, [job("test")], github.deps)).toBeNull();
  });

  it("refuses a permission the installation lacks before minting, naming it", async () => {
    const github = fakeGithub({ contents: "read", issues: "write" });
    const lent = await lendGithubTokens(
      run,
      [job("release", { contents: "write", issues: "write" }), job("triage", { issues: "read" })],
      github.deps,
    );
    expect(lent?.["contents=write,issues=write"]).toEqual({
      refused:
        "the Infrawrench GitHub App's installation on acme does not have contents: write, so it cannot lend a token with it; an owner of acme can grant it from the installation's settings on GitHub",
    });
    // A lesser permission it has is minted.
    expect(lent?.["issues=read"]).toHaveProperty("expires-at");
    expect(github.mints).toHaveLength(1);
  });

  it("refuses with GitHub's answer when it will not mint, and with a reason for a name it does not know", async () => {
    const lent = await lendGithubTokens(
      run,
      [job("release", { contents: "write" }), job("odd", { administration: "write" })],
      {
        installationPermissions: async () => null,
        mint: async () => {
          throw new Error(
            "GitHub answered 422: The permissions requested are not granted to this installation.",
          );
        },
      },
    );
    expect(lent?.["contents=write"]).toEqual({
      refused:
        "GitHub would not mint a token for acme/web: GitHub answered 422: The permissions requested are not granted to this installation.",
    });
    expect(lent?.["administration=write"]).toEqual({
      refused: "a job's GitHub token cannot have administration: write",
    });
    expect(audited).toEqual([]);
  });

  it("checks levels: write covers read, read does not cover write", () => {
    expect(missingPermissions({ contents: "read" }, { contents: "write" })).toEqual([]);
    expect(missingPermissions({ "pull-requests": "write" }, { pull_requests: "read" })).toEqual([
      "pull-requests: write",
    ]);
    expect(missingPermissions({ statuses: "read" }, {})).toEqual(["statuses: read"]);
  });
});

describe("what a job is given", () => {
  const entry = githubTokenEntry("acme/web", TOKEN, EXPIRES);
  if ("refused" in entry) throw new Error("unreachable");

  it("sets the variables gh and the API clients read, the token masked and the rest shown", () => {
    expect(parts(entry.env["GH_TOKEN"]!)).toEqual({ shown: "", masked: [TOKEN] });
    expect(parts(entry.env["GITHUB_TOKEN"]!)).toEqual({ shown: "", masked: [TOKEN] });
    expect(parts(entry.env["GH_REPO"]!)).toEqual({ shown: "acme/web", masked: [] });
    expect(parts(entry.env["GIT_CONFIG_GLOBAL"]!)).toEqual({ shown: GIT_CONFIG_PATH, masked: [] });
    expect(parts(entry.env["GIT_TERMINAL_PROMPT"]!)).toEqual({ shown: "0", masked: [] });
  });

  it("gives Git the token as a header for the repository's URLs, the header masked", () => {
    expect(entry.files).toHaveLength(1);
    const [file] = entry.files;
    expect(file).toMatchObject({ path: "/root/.gitconfig", mode: "600" });
    const { shown, masked } = parts(file!.content);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(masked).toEqual([basic, basic]);
    expect(shown).toBe(
      '[http "https://github.com/acme/web"]\n\textraheader = AUTHORIZATION: basic \n' +
        '[http "https://github.com/acme/web.git"]\n\textraheader = AUTHORIZATION: basic \n',
    );
    expect(shown).not.toContain(TOKEN);
  });

  it("says when the token expires, which the runner checks against each job's start and timeout", () => {
    // GitHub's expiry, to the second: the runner refuses a job that starts
    // after it and notes one whose timeout ends after it (`lent.rs`).
    expect(entry["expires-at"]).toBe(Date.parse(EXPIRES) / 1000);
    expect(Number.isInteger(entry["expires-at"])).toBe(true);
  });
});

describe("mintRepositoryToken, against a fake GitHub", () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let answer: Response;

  beforeEach(() => {
    requests.length = 0;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    );
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return answer;
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks as the App for one repository and the permissions named, and never caches", async () => {
    answer = new Response(JSON.stringify({ token: TOKEN, expires_at: EXPIRES }), { status: 201 });
    const got = await mintRepositoryToken(42, "web", { contents: "write", pull_requests: "write" });
    expect(got).toEqual({ token: TOKEN, expiresAt: EXPIRES });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      repositories: ["web"],
      permissions: { contents: "write", pull_requests: "write" },
    });
    const auth = (requests[0]!.init.headers as Record<string, string>)["Authorization"];
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    answer = new Response(JSON.stringify({ token: TOKEN, expires_at: EXPIRES }), { status: 201 });
    await mintRepositoryToken(42, "web", { contents: "write" });
    expect(requests).toHaveLength(2);
  });

  it("says what GitHub answered when it refuses", async () => {
    answer = new Response(
      JSON.stringify({
        message: "The permissions requested are not granted to this installation.",
      }),
      { status: 422 },
    );
    await expect(mintRepositoryToken(42, "web", { issues: "write" })).rejects.toThrow(
      "GitHub answered 422: The permissions requested are not granted to this installation.",
    );
  });
});
