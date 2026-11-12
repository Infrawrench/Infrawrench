import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `runs.ts` imports the database client and the GitHub App at load; what is
// tested here touches neither.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { downloadLink, DownloadLinkError, signDownload, toDownload } = await import("../downloads");
const { jobsOf } = await import("../runs");

const NOW = 1_800_000_000;
const RUN = "0123456789abcdef0123456789abcdef";
const OBJECT = `${NOW + 86_400}-${"ab".repeat(16)}`;
const STORED = {
  path: "reports/junit é.xml",
  size: 42,
  sha256: "c".repeat(64),
  content_type: "application/xml",
  expires_at: NOW + 86_400,
  key: `artifacts/github.com-acme/web/${RUN}/${OBJECT}`,
  masked: true,
};

describe("download links", () => {
  const env = { ...process.env };
  beforeEach(() => {
    // A fixed test key, not a real secret.
    process.env["CI_ARTIFACT_SIGNING_KEY"] = "download-test-key-not-a-real-secret";
    process.env["CI_PROXY_URL"] = "https://ci-proxy.example/";
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("signs as the proxy checks (a vector both test suites share)", () => {
    // The same fields and key as ci-proxy's artifacts.test.ts.
    expect(
      signDownload("vector-key", {
        owner: "github.com-acme",
        repoId: "web",
        run: RUN,
        object: "1800086400-abababababababababababababababab",
        name: "report.html",
        expires: 1_800_000_900,
      }),
    ).toBe("PK6ELOhorwq8mbJJ-xC_6fqxDrl9CTa7m4V2HphcOzc");
  });

  it("makes a link to the proxy for one file, for fifteen minutes", () => {
    const link = downloadLink("github.com-acme", "web", RUN, STORED, NOW);
    const url = new URL(link.url);
    expect(url.origin).toBe("https://ci-proxy.example");
    expect(url.pathname).toBe(`/v1/artifacts/github.com-acme/web/${RUN}/${OBJECT}`);
    expect(url.searchParams.get("n")).toBe("junit é.xml");
    expect(url.searchParams.get("e")).toBe(String(NOW + 900));
    expect(url.searchParams.get("s")).toBe(
      signDownload("download-test-key-not-a-real-secret", {
        owner: "github.com-acme",
        repoId: "web",
        run: RUN,
        object: OBJECT,
        name: "junit é.xml",
        expires: NOW + 900,
      }),
    );
    expect(link.expiresAt).toBe(new Date((NOW + 900) * 1000).toISOString());
  });

  it("ends a link with its file, and refuses files not under the run", () => {
    const soon = { ...STORED, key: STORED.key.replace(OBJECT, `${NOW + 60}-${"ab".repeat(16)}`) };
    expect(downloadLink("github.com-acme", "web", RUN, soon, NOW).expiresAt).toBe(
      new Date((NOW + 60) * 1000).toISOString(),
    );
    const expired = { ...STORED, key: STORED.key.replace(OBJECT, `${NOW}-${"ab".repeat(16)}`) };
    expect(() => downloadLink("github.com-acme", "web", RUN, expired, NOW)).toThrow(/expired/);
    // A report naming another repository's file gets no link.
    expect(() => downloadLink("github.com-acme", "api", RUN, STORED, NOW)).toThrow(
      DownloadLinkError,
    );
    expect(() => downloadLink("github.com-acme", "web", "f".repeat(32), STORED, NOW)).toThrow(
      DownloadLinkError,
    );
    const odd = { ...STORED, path: "dir/bad\nname\\x" };
    expect(
      new URL(downloadLink("github.com-acme", "web", RUN, odd, NOW).url).searchParams.get("n"),
    ).toBe("bad_name_x");
  });

  it("says so when the server has no signing key", () => {
    delete process.env["CI_ARTIFACT_SIGNING_KEY"];
    try {
      downloadLink("github.com-acme", "web", RUN, STORED, NOW);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DownloadLinkError);
      expect((e as InstanceType<typeof DownloadLinkError>).status).toBe(409);
    }
  });
});

describe("a run's downloads", () => {
  it("are listed with each job's output, in the API's shape", () => {
    const jobs = jobsOf(
      {
        id: RUN,
        state: "finished",
        result: {
          run_id: RUN,
          pipelines: [
            {
              outcome: "ran",
              report: {
                pipeline: "Tests",
                jobs: [
                  { id: "a", status: "passed", downloads: [STORED, { path: "broken" }] },
                  { id: "b", status: "passed" },
                ],
              },
            },
          ],
        },
      },
      true,
    );
    expect(jobs[0]).toMatchObject({
      downloads: [
        {
          path: "reports/junit é.xml",
          size: 42,
          sha256: "c".repeat(64),
          contentType: "application/xml",
          expiresAt: new Date((NOW + 86_400) * 1000).toISOString(),
          masked: true,
        },
      ],
    });
    expect("downloads" in jobs[1]!).toBe(false);
    // The summary stored with the run never carries them.
    expect(
      "downloads" in jobsOf({ id: RUN, state: "finished", result: { pipelines: [] } }, false),
    ).toBe(false);
    expect(toDownload({ path: "x" })).toBeNull();
  });
});
