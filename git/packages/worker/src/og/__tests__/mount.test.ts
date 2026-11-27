/**
 * The two routes with the lookup replaced: what a page's shell and its image
 * answer for each kind of page, for a private page and a missing one (the
 * same bytes), when the lookup fails or is slow, and for a signed-in
 * person's page (no lookup at all).
 */
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../env";
import { cardNode } from "../card";
import type { OgFacts } from "../facts";
import { type Card, SITE_CARD, cardOf, cardVersion } from "../meta";
import {
  type FactsLookup,
  LOOKUP_TIMEOUT_MS,
  imageCacheControl,
  ogImageFetch,
  pageFetch,
  parseOgImagePath,
} from "../mount";
import type { OgPage } from "../pages";
import { renderCard } from "../render";
import { type Rewriter, type ShellEdit } from "../shell";
import { FIXTURES, nodeAssets } from "./fixtures";

const env = {} as Env;
const ctx = { waitUntil: () => undefined };

/** Records what the shell is told, and answers the edits as JSON to compare. */
const recorder = (): Rewriter => {
  const edits: ShellEdit[] = [];
  const rewriter: Rewriter = {
    on(selector, handlers) {
      handlers.element({
        setAttribute: (attribute, value) => edits.push({ selector, attribute, value }),
        setInnerContent: (text) => edits.push({ selector, text }),
      });
      return rewriter;
    },
    transform: (response) =>
      new Response(JSON.stringify(edits), { status: response.status, headers: response.headers }),
  };
  return rewriter;
};

const shell = () => new Response("<html></html>", { headers: { "content-type": "text/html" } });

const tagsFor = async (path: string, find: FactsLookup): Promise<string> =>
  (
    await pageFetch(new Request(`https://git.infrawrench.com${path}`), env, ctx, shell(), {
      find,
      rewriter: recorder,
    })
  ).text();

/** Answers like the lookup: the fixture for one repository, nothing for anything else. */
const only =
  (owner: string, facts: OgFacts): FactsLookup =>
  async (page: OgPage) =>
    "owner" in page && page.owner === owner ? facts : null;

describe("a page's tags", () => {
  it("are the same for a private page as for a missing one", async () => {
    const find = only("acme", FIXTURES["repository"]!);
    const generic = await tagsFor("/", find);
    expect(await tagsFor("/alice/private-repo", find)).toBe(generic);
    expect(await tagsFor("/alice/no-such-repo", find)).toBe(generic);
    expect(await tagsFor("/alice/private-repo/issues/3", find)).toBe(generic);
    expect(await tagsFor("/acme/platform-infra", find)).not.toBe(generic);
  });

  it("never look anything up for a signed-in person's page", async () => {
    const find = vi.fn<FactsLookup>(async () => FIXTURES["repository"]!);
    const generic = await tagsFor("/", find);
    expect(await tagsFor("/acme/platform-infra/settings", find)).toBe(generic);
    expect(await tagsFor("/settings/tokens", find)).toBe(generic);
    expect(find).not.toHaveBeenCalled();
  });

  it("fall back to the site's when the lookup fails or is slow", async () => {
    const generic = await tagsFor("/", async () => null);
    expect(
      await tagsFor("/acme/platform-infra", async () => {
        throw new Error("database away");
      }),
    ).toBe(generic);
    vi.useFakeTimers();
    try {
      const slow = tagsFor("/acme/platform-infra", () => new Promise<never>(() => undefined));
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS + 1);
      expect(await slow).toBe(generic);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leave a shell alone that is not theirs to change, when making them fails", async () => {
    const answer = await pageFetch(
      new Request("https://git.infrawrench.com/acme/platform-infra"),
      env,
      ctx,
      shell(),
      {
        find: async () => ({ kind: "bogus" }) as unknown as OgFacts,
        rewriter: recorder,
      },
    );
    expect(await answer.text()).toBe("<html></html>");
  });
});

describe("a page's image", () => {
  const draw = async (card: Card) => ({
    png: new TextEncoder().encode(JSON.stringify(card)),
    complete: true,
  });

  const fetchImage = (path: string, find: FactsLookup, method = "GET") =>
    ogImageFetch(new Request(`https://git.infrawrench.com${path}`, { method }), env, ctx, {
      find,
      draw,
    });

  it("is the page's card as it is now, kept long only at its current version", async () => {
    const facts = FIXTURES["repository"]!;
    const version = await cardVersion(cardOf(facts).card);
    const find = only("acme", facts);
    const current = await fetchImage(`/-/og/${version}/acme/platform-infra`, find);
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/png");
    expect(current.headers.get("cache-control")).toBe(imageCacheControl(true));
    expect(JSON.parse(await current.text())).toEqual(facts);

    const stale = await fetchImage(`/-/og/0000000000000000/acme/platform-infra`, find);
    expect(stale.headers.get("cache-control")).toBe(imageCacheControl(false));
    expect(JSON.parse(await stale.text())).toEqual(facts);
  });

  it("is the site's card for a private page and a missing one, byte for byte", async () => {
    const find = only("acme", FIXTURES["repository"]!);
    const version = await cardVersion(SITE_CARD);
    const answers = await Promise.all(
      ["/alice/private-repo", "/alice/no-such-repo", "/alice/private-repo/issues/3"].map((path) =>
        fetchImage(`/-/og/${version}${path}`, find),
      ),
    );
    const bodies = await Promise.all(answers.map((answer) => answer.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual(SITE_CARD);
    const headers = answers.map((answer) => JSON.stringify([...answer.headers]));
    expect(new Set(headers).size).toBe(1);
  });

  it("answers HEAD with the headers alone, and 404 for no card's address", async () => {
    const head = await fetchImage(
      `/-/og/${await cardVersion(SITE_CARD)}`,
      async () => null,
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const path of [
      "/-/og/",
      "/-/og/nothex",
      "/-/og/0123456789abcdef/settings",
      "/-/og/0123456789abcdef/acme/infra/issues",
      "/-/og/0123456789abcdef/acme/infra/tree/main/a",
    ]) {
      expect((await fetchImage(path, async () => null)).status, path).toBe(404);
    }
    expect(
      (await fetchImage(`/-/og/${await cardVersion(SITE_CARD)}`, async () => null, "POST")).status,
    ).toBe(405);
  });

  it("is a real PNG of the site's card when drawn", async () => {
    const png = await renderCard(cardNode(SITE_CARD), await nodeAssets());
    expect(png.byteLength).toBeGreaterThan(5_000);
    expect(png.byteLength).toBeLessThan(500_000);
  });
});

describe("parseOgImagePath", () => {
  it("reads the version and the page", () => {
    expect(parseOgImagePath("/-/og/0123456789abcdef")).toEqual({
      version: "0123456789abcdef",
      page: { kind: "home" },
    });
    expect(parseOgImagePath("/-/og/0123456789abcdef/acme/infra/branches/feature/a")).toEqual({
      version: "0123456789abcdef",
      page: { kind: "branch", owner: "acme", repo: "infra", key: "feature/a" },
    });
  });
});
