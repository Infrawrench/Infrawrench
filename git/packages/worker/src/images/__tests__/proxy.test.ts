import { describe, expect, it } from "vitest";
import {
  IMAGE_CONTENT_SECURITY_POLICY,
  IMAGE_PROXY_LIMITS,
  blockedHost,
  imageSource,
  proxyImage,
} from "../proxy";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SITE = ["git.infrawrench.com"];

const fromPage = (url: string, extra: Record<string, string> = {}, method = "GET") =>
  new Request(`https://git.infrawrench.com/-/image?url=${encodeURIComponent(url)}`, {
    method,
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "image",
      cookie: "__Host-iwg-session=secret",
      "user-agent": "Reader's browser",
      "cf-connecting-ip": "203.0.113.9",
      ...extra,
    },
  });

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const upstream = (respond: (url: string) => Response) => {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url);
    },
  };
};

const image = (body: Uint8Array<ArrayBuffer> = PNG, type = "image/png") =>
  new Response(body, { headers: { "content-type": type, "content-length": String(body.length) } });

describe("blockedHost", () => {
  it("refuses addresses that are not public", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "[::1]",
      "[::]",
      "[fc00::1]",
      "[fe80::1]",
      "[::ffff:7f00:1]",
      "[64:ff9b::a00:1]",
      "[2002:7f00:1::]",
      "[2::1]",
      "localhost",
      "printer.local",
      "metadata.google.internal",
      "router.home.arpa",
      "intranet",
    ]) {
      expect(blockedHost(host), host).toBe(true);
    }
  });

  it("lets public names and addresses through", () => {
    for (const host of [
      "example.com",
      "img.shields.io",
      "8.8.8.8",
      "172.32.0.1",
      "[2606:4700::1111]",
      "example.com.",
    ]) {
      expect(blockedHost(host), host).toBe(false);
    }
  });

  it("is given what URL makes of a disguised address", () => {
    // `URL` reads these as 127.0.0.1, which is what the check sees.
    for (const spelt of ["http://0x7f.1/a.png", "http://2130706433/a.png", "http://127.1/a.png"]) {
      expect(imageSource(spelt, SITE), spelt).toBeNull();
    }
  });
});

describe("imageSource", () => {
  it("takes http and https addresses on other hosts", () => {
    expect(imageSource("https://example.com/a.png#x", SITE)?.href).toBe(
      "https://example.com/a.png",
    );
    expect(imageSource("http://example.com/a.png", SITE)?.href).toBe("http://example.com/a.png");
  });

  it("refuses other schemes, credentials and this site", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "ftp://example.com/a.png",
      "https://user:pass@example.com/a.png",
      "https://GIT.infrawrench.com/-/image?url=x",
      "/relative.png",
      "",
    ]) {
      expect(imageSource(value, SITE), value).toBeNull();
    }
  });
});

describe("proxyImage", () => {
  it("fetches the image without anything of the reader's and serves it sandboxed", async () => {
    const up = upstream(() => image());
    const response = await proxyImage(fromPage("https://example.com/badge.png"), {
      fetch: up.fetch,
      siteHosts: SITE,
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    expect(up.calls).toHaveLength(1);
    const sent = new Headers(up.calls[0]!.init.headers);
    expect([...sent.keys()].sort()).toEqual(["accept", "user-agent"]);
    expect(sent.get("user-agent")).not.toContain("Reader");
    expect(up.calls[0]!.init.redirect).toBe("manual");
  });

  it("is refused to anything but an image on this site's pages", async () => {
    const up = upstream(() => image());
    const options = { fetch: up.fetch, siteHosts: SITE };
    const cases: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none", "sec-fetch-dest": "document" },
      { "sec-fetch-dest": "document" },
      { "sec-fetch-dest": "script" },
    ];
    for (const headers of cases) {
      const response = await proxyImage(fromPage("https://example.com/a.png", headers), options);
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    const bare = new Request(
      `https://git.infrawrench.com/-/image?url=${encodeURIComponent("https://example.com/a.png")}`,
    );
    expect((await proxyImage(bare, options)).status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });

  it("refuses an address it does not load from before fetching anything", async () => {
    const up = upstream(() => image());
    for (const url of ["http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "nope"]) {
      const response = await proxyImage(fromPage(url), { fetch: up.fetch, siteHosts: SITE });
      expect(response.status, url).toBe(400);
    }
    expect(up.calls).toHaveLength(0);
  });

  it("follows a few redirects, checking each", async () => {
    const hops = upstream((url) =>
      url === "https://a.example/1"
        ? new Response(null, { status: 302, headers: { location: "/2" } })
        : url === "https://a.example/2"
          ? new Response(null, { status: 301, headers: { location: "https://b.example/3.png" } })
          : image(),
    );
    const ok = await proxyImage(fromPage("https://a.example/1"), {
      fetch: hops.fetch,
      siteHosts: SITE,
    });
    expect(ok.status).toBe(200);
    expect(hops.calls.map((call) => call.url)).toEqual([
      "https://a.example/1",
      "https://a.example/2",
      "https://b.example/3.png",
    ]);

    const inward = upstream(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/x" } }),
    );
    const refused = await proxyImage(fromPage("https://a.example/1"), {
      fetch: inward.fetch,
      siteHosts: SITE,
    });
    expect(refused.status).toBe(502);
    expect(inward.calls).toHaveLength(1);

    const loop = upstream(
      () => new Response(null, { status: 302, headers: { location: "https://a.example/again" } }),
    );
    const looped = await proxyImage(fromPage("https://a.example/1"), {
      fetch: loop.fetch,
      siteHosts: SITE,
    });
    expect(looped.status).toBe(502);
    expect(loop.calls).toHaveLength(IMAGE_PROXY_LIMITS.maxRedirects + 1);
  });

  it("refuses what is not an image", async () => {
    for (const type of ["text/html", "application/octet-stream", "", "text/plain"]) {
      const up = upstream(
        () => new Response("<script>alert(1)</script>", { headers: { "content-type": type } }),
      );
      const response = await proxyImage(fromPage("https://example.com/a.png"), {
        fetch: up.fetch,
        siteHosts: SITE,
      });
      expect(response.status, type).toBe(415);
    }
  });

  it("passes on a missing image as missing and a failing host as a bad gateway", async () => {
    const missing = upstream(() => new Response("gone", { status: 404 }));
    expect(
      (
        await proxyImage(fromPage("https://example.com/a.png"), {
          fetch: missing.fetch,
          siteHosts: SITE,
        })
      ).status,
    ).toBe(404);
    const failing = upstream(() => new Response("down", { status: 503 }));
    expect(
      (
        await proxyImage(fromPage("https://example.com/a.png"), {
          fetch: failing.fetch,
          siteHosts: SITE,
        })
      ).status,
    ).toBe(502);
    const throwing = {
      fetch: async () => {
        throw new Error("connect failed");
      },
      siteHosts: SITE,
    };
    expect((await proxyImage(fromPage("https://example.com/a.png"), throwing)).status).toBe(502);
  });

  it("refuses an image that says it is too large, and cuts off one that turns out to be", async () => {
    const declared = upstream(
      () =>
        new Response(PNG, {
          headers: {
            "content-type": "image/png",
            "content-length": String(IMAGE_PROXY_LIMITS.maxBytes + 1),
          },
        }),
    );
    expect(
      (
        await proxyImage(fromPage("https://example.com/a.png"), {
          fetch: declared.fetch,
          siteHosts: SITE,
        })
      ).status,
    ).toBe(413);

    const big = new Uint8Array(IMAGE_PROXY_LIMITS.maxBytes + 1);
    const undeclared = upstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(big);
              controller.close();
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    );
    const response = await proxyImage(fromPage("https://example.com/a.png"), {
      fetch: undeclared.fetch,
      siteHosts: SITE,
    });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const up = upstream(() => image());
    const head = await proxyImage(fromPage("https://example.com/a.png", {}, "HEAD"), {
      fetch: up.fetch,
      siteHosts: SITE,
    });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const post = await proxyImage(fromPage("https://example.com/a.png", {}, "POST"), {
      fetch: up.fetch,
      siteHosts: SITE,
    });
    expect(post.status).toBe(405);
  });
});
