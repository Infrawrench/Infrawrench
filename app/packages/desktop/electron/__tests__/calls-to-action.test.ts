import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime, Effect } from "effect";

vi.mock("electron", () => ({ app: { getPath: () => "", getVersion: () => "0.0.0" } }));

const {
  compareVersions,
  firstLaunchMillis,
  makeCallsToAction,
  resolveMarkdownUrl,
  selectCallsToAction,
} = await import("../calls-to-action");

const at = (iso: string) => DateTime.makeUnsafe(iso);

const baseContext = {
  installedAt: at("2026-06-01T00:00:00Z"),
  now: at("2026-11-25T00:00:00Z"),
  completed: new Set<string>(),
  os: "mac" as const,
  appVersion: "1.4.0",
  signedIn: false,
  signInAvailable: true,
  locale: "en",
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: "cta",
  addedAt: "2026-11-01T00:00:00Z",
  markdown: "# Hello",
  action: { type: "url", url: "https://infrawrench.com/blog" },
  ...over,
});

const ids = (entries: unknown[], ctx: Partial<typeof baseContext> = {}) =>
  selectCallsToAction(entries, { ...baseContext, ...ctx }).map((c) => c.id);

describe("selectCallsToAction", () => {
  it("shows only what was added after the install, oldest first", () => {
    expect(
      ids([
        entry({ id: "newer", addedAt: "2026-11-10T00:00:00Z" }),
        entry({ id: "before-install", addedAt: "2026-05-01T00:00:00Z" }),
        entry({ id: "older", addedAt: "2026-10-01T00:00:00Z" }),
      ]),
    ).toEqual(["older", "newer"]);
  });

  it("skips completed, scheduled and expired ones", () => {
    expect(ids([entry({ id: "done" })], { completed: new Set(["done"]) })).toEqual([]);
    expect(ids([entry({ addedAt: "2026-12-01T00:00:00Z" })])).toEqual([]);
    expect(ids([entry({ expiresAt: "2026-11-20T00:00:00Z" })])).toEqual([]);
    expect(ids([entry({ expiresAt: "2026-12-20T00:00:00Z" })])).toEqual(["cta"]);
  });

  it("checks the os, account and app version", () => {
    expect(ids([entry({ when: { os: ["windows", "linux"] } })])).toEqual([]);
    expect(ids([entry({ when: { os: ["mac"] } })])).toEqual(["cta"]);
    expect(ids([entry({ when: { account: "local" } })], { signedIn: true })).toEqual([]);
    expect(ids([entry({ when: { account: "cloud" } })], { signedIn: true })).toEqual(["cta"]);
    expect(ids([entry({ when: { account: "cloud" } })])).toEqual([]);
    expect(ids([entry({ when: { minAppVersion: "1.5" } })])).toEqual([]);
    expect(ids([entry({ when: { minAppVersion: "1.4.0", maxAppVersion: "1.4" } })])).toEqual([
      "cta",
    ]);
    expect(ids([entry({ when: { maxAppVersion: "1.3.9" } })])).toEqual([]);
  });

  it("offers sign-in only to signed-out users of a build that has it", () => {
    const signIn = entry({ action: { type: "sign-in" } });
    expect(ids([signIn])).toEqual(["cta"]);
    expect(ids([signIn], { signedIn: true })).toEqual([]);
    expect(ids([signIn], { signInAvailable: false })).toEqual([]);
  });

  it("skips what this build cannot fully understand", () => {
    expect(
      ids([
        entry({ id: "unknown-condition", when: { os: ["mac"], plan: "pro" } }),
        entry({ id: "unknown-action", action: { type: "install-plugin" } }),
        entry({ id: "no-body", markdown: undefined }),
        entry({ id: "bad-date", addedAt: "yesterday" }),
        entry({ id: "javascript-url", action: { type: "url", url: "javascript:alert(1)" } }),
        "not an object",
        entry({ id: "fine" }),
      ]),
    ).toEqual(["fine"]);
  });

  it("uses the locale's translation, then the language's", () => {
    const translated = entry({
      actionLabel: "Read it",
      dismissLabel: "Later",
      layout: "side-by-side",
      translations: {
        fr: { markdown: "# Bonjour", actionLabel: "Lire" },
        "pt-BR": { markdownFile: "pt.md" },
      },
    });
    const [fr] = selectCallsToAction([translated], { ...baseContext, locale: "fr-CA" });
    expect(fr).toMatchObject({
      body: { markdown: "# Bonjour" },
      actionLabel: "Lire",
      dismissLabel: "Later",
      layout: "side-by-side",
    });
    const [pt] = selectCallsToAction([translated], { ...baseContext, locale: "pt-br" });
    expect(pt?.body).toEqual({ markdownFile: "pt.md" });
    const [en] = selectCallsToAction([entry()], baseContext);
    expect(en).toMatchObject({ actionLabel: null, dismissLabel: null, layout: "stacked" });
  });
});

describe("helpers", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4", "1.4.0")).toBe(0);
    expect(compareVersions("1.4.0-beta.1", "1.4.0")).toBe(0);
  });

  it("dates an install from the oldest time on the files a launch leaves", () => {
    const times: Record<string, { birthtimeMs: number; mtimeMs: number }> = {
      "/state/master.key.enc": { birthtimeMs: 5_000, mtimeMs: 9_000 },
      // Some file systems report no birth time.
      "/state/infrawrench.db": { birthtimeMs: 0, mtimeMs: 3_000 },
    };
    const stat = (file: string) => {
      const t = times[file];
      if (!t) throw new Error("ENOENT");
      return t;
    };
    expect(firstLaunchMillis("/state", 10_000, stat)).toBe(3_000);
    expect(firstLaunchMillis("/elsewhere", 10_000, stat)).toBe(10_000);
  });

  it("keeps markdown files on the manifest's origin", () => {
    const manifest = "https://infrawrench.com/desktop/calls-to-action/index.json";
    expect(resolveMarkdownUrl(manifest, "sign-in.md")).toBe(
      "https://infrawrench.com/desktop/calls-to-action/sign-in.md",
    );
    expect(resolveMarkdownUrl(manifest, "https://evil.example/x.md")).toBeNull();
    expect(resolveMarkdownUrl(manifest, "//evil.example/x.md")).toBeNull();
  });
});

describe("makeCallsToAction", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-cta-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifestUrl = "https://infrawrench.com/desktop/calls-to-action/index.json";

  function service(files: Record<string, string | number>) {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const body = files[String(input)];
      if (body === undefined || typeof body === "number")
        return new Response("nope", { status: typeof body === "number" ? body : 404 });
      return new Response(body);
    });
    const ctas = makeCallsToAction({
      manifestUrl,
      signInAvailable: true,
      stateDir: () => dir,
      appVersion: () => "1.4.0",
      platform: "darwin",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    return { ctas, fetch };
  }

  it("fetches bodies, keeps the install time, and remembers completions", async () => {
    // Installed before any of the entries. (Seeded rather than dated through
    // file times: CI's in-memory file system ignores utimes.)
    fs.writeFileSync(
      path.join(dir, "calls-to-action.json"),
      JSON.stringify({ installedAt: "2026-01-01T00:00:00.000Z", completed: {} }),
    );

    const { ctas } = service({
      [manifestUrl]: JSON.stringify({
        callsToAction: [
          entry({ id: "inline", addedAt: "2026-02-01T00:00:00Z" }),
          entry({
            id: "file",
            addedAt: "2026-03-01T00:00:00Z",
            markdown: undefined,
            markdownFile: "file.md",
            action: { type: "sign-in" },
          }),
          entry({
            id: "missing-file",
            addedAt: "2026-04-01T00:00:00Z",
            markdown: undefined,
            markdownFile: "gone.md",
          }),
        ],
      }),
      "https://infrawrench.com/desktop/calls-to-action/file.md": "# From a file",
    });

    const first = await Effect.runPromise(ctas.pending({ signedIn: false, locale: "en" }));
    expect(first.map((c) => [c.id, c.markdown])).toEqual([
      ["inline", "# Hello"],
      ["file", "# From a file"],
    ]);

    await Effect.runPromise(ctas.complete("inline"));
    const second = await Effect.runPromise(ctas.pending({ signedIn: false, locale: "en" }));
    expect(second.map((c) => c.id)).toEqual(["file"]);

    const state = JSON.parse(fs.readFileSync(path.join(dir, "calls-to-action.json"), "utf8"));
    expect(state.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(Object.keys(state.completed)).toEqual(["inline"]);
  });

  it("shows a fresh install nothing from before it, and nothing when the file is unreachable", async () => {
    const { ctas } = service({
      [manifestUrl]: JSON.stringify({ callsToAction: [entry()] }),
    });
    expect(await Effect.runPromise(ctas.pending({ signedIn: false, locale: "en" }))).toEqual([]);

    const down = service({ [manifestUrl]: 503 });
    expect(await Effect.runPromise(down.ctas.pending({ signedIn: false, locale: "en" }))).toEqual(
      [],
    );
    const garbage = service({ [manifestUrl]: "<html>" });
    expect(
      await Effect.runPromise(garbage.ctas.pending({ signedIn: false, locale: "en" })),
    ).toEqual([]);
  });
});
