/** A card's pictures follow the image proxy's rules: public addresses only, images only, small. */
import { describe, expect, it } from "vitest";
import { CARD_IMAGE_LIMITS, type CardImageOptions, cardImages } from "../images";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const options = (answer: (url: string) => Response, seen: string[] = []): CardImageOptions => ({
  fetch: async (url, init) => {
    seen.push(url);
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("cookie")).toBeNull();
    return answer(url);
  },
  siteHosts: ["git.infrawrench.com"],
  origin: "https://git.infrawrench.com",
});

const png = () => new Response(PNG, { headers: { "content-type": "image/png" } });

describe("cardImages", () => {
  it("fetches a public picture as a data URL", async () => {
    const found = await cardImages(["https://avatars.example.com/a.png"], options(png));
    expect(found.get("https://avatars.example.com/a.png")).toMatch(/^data:image\/png;base64,/);
  });

  it("never fetches a private address, this site, or one a redirect points inside", async () => {
    const seen: string[] = [];
    const found = await cardImages(
      [
        "http://127.0.0.1/a.png",
        "http://169.254.169.254/latest",
        "https://git.infrawrench.com/x.png",
        "https://redirects.example.com/a.png",
      ],
      options(
        () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/a.png" } }),
        seen,
      ),
    );
    expect(found.size).toBe(0);
    expect(seen).toEqual(["https://redirects.example.com/a.png"]);
  });

  it("leaves out what is not a PNG, JPEG or GIF, and what is too large", async () => {
    const found = await cardImages(
      ["https://a.example.com/svg", "https://a.example.com/big", "https://a.example.com/html"],
      options((url) =>
        url.endsWith("svg")
          ? new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
          : url.endsWith("big")
            ? new Response(new Uint8Array(CARD_IMAGE_LIMITS.maxBytes + 1), {
                headers: { "content-type": "image/png" },
              })
            : new Response("<html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    expect(found.size).toBe(0);
  });

  it("reads this site's own pictures from the built UI only under /assets/", async () => {
    const asked: string[] = [];
    const found = await cardImages(["/assets/bots/a.png", "/settings", "/assets/../x"], {
      ...options(png),
      assets: {
        fetch: async (request) => {
          asked.push((request as unknown as Request).url);
          return png() as never;
        },
      },
    });
    expect([...found.keys()]).toEqual(["/assets/bots/a.png"]);
    expect(asked).toEqual(["https://git.infrawrench.com/assets/bots/a.png"]);
  });
});
