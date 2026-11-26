import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MARKDOWN_MAX_DEPTH,
  containerDepth,
  withinMarkdownLimits,
} from "../../lib/markdown-limits";
import { Markdown } from "../Markdown";
import MarkdownBody from "../MarkdownBody";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { push: vi.fn(), replace: vi.fn() } }),
  useLocation: () => "/",
}));

afterEach(cleanup);

const html = (source: string, props: Partial<Parameters<typeof MarkdownBody>[0]> = {}) => {
  const { container } = render(<MarkdownBody source={source} {...props} />);
  return container;
};

/** Every attribute value in the rendered tree. */
const attributes = (root: Element): string[] =>
  [...root.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`),
  );

describe("Markdown links and images never carry a script or a document", () => {
  test.each([
    "[a](javascript:alert(1))",
    "[a](JaVaScRiPt:alert(1))",
    "[a](&#106;avascript:alert(1))",
    "[a](&#x6A;avascript&#x3A;alert(1))",
    "[a](javascript&colon;alert(1))",
    "[a](<java\tscript:alert(1)>)",
    "<javascript:alert(1)>",
    "[a][r]\n\n[r]: javascript:alert(1)",
    "[a][r]\n\n[r]: <data:text/html,<script>alert(1)</script>>",
    "[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[a](vbscript:msgbox(1))",
    "[a](file:///etc/passwd)",
    "![a](javascript:alert(1))",
    "![a](data:image/svg+xml;base64,PHN2Zz4=)",
    "![a][r]\n\n[r]: data:image/png;base64,AAAA",
    "[![a](https://example.com/a.png)](javascript:alert(1))",
  ])("%j", (source) => {
    const root = html(source);
    for (const value of attributes(root)) {
      expect(value).not.toMatch(/^(href|src)=\s*(javascript|vbscript|data|file):/i);
    }
    expect(root.querySelector("a[href^='javascript' i], a[href^='data' i]")).toBeNull();
    expect(root.querySelector("img[src^='data' i], img[src^='javascript' i]")).toBeNull();
  });

  test("a refused link is its text, not a link to this page", () => {
    const root = html("[click](javascript:alert(1))");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toBe("click");
  });

  test("a refused image is its alt text", () => {
    const root = html("![diagram](data:image/png;base64,AAAA)");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toBe("diagram");
  });
});

describe("Markdown never renders HTML from the source", () => {
  test.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    '<form action="/x"><input name="a"><button>Go</button></form>',
    '<iframe src="https://example.com"></iframe>',
    '<object data="x"></object><embed src="x">',
    "<svg><script>alert(1)</script></svg>",
    "<math><mtext><img src=x onerror=alert(1)></mtext></math>",
    "<style>body{display:none}</style>",
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/a.css">',
    '<div style="position:fixed;inset:0" class="fixed inset-0 z-50">Sign in</div>',
    '<p id="root" name="api">x</p>',
    "text <b onmouseover=alert(1)>bold</b>",
  ])("%j", (source) => {
    const root = html(source);
    expect(
      root.querySelector(
        "script, img, iframe, object, embed, form, input:not([type=checkbox]), button, svg, math, style, base, meta, link, b, [style], [onerror], [onmouseover], #root",
      ),
    ).toBeNull();
    expect(root.textContent).toContain("<");
  });

  test("a code fence's info string adds no class to the page", () => {
    const root = html("```js fixed inset-0 z-50\nx\n```");
    expect(root.querySelector(".fixed, .inset-0, [class*='language-']")).toBeNull();
  });

  test("task list checkboxes are inert", () => {
    const root = html("- [x] done\n- [ ] not yet");
    const boxes = [...root.querySelectorAll("input")];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.type).toBe("checkbox");
      expect(box.disabled).toBe(true);
    }
  });

  test("footnote ids are prefixed, so they cannot shadow the page's own", () => {
    const root = html("a[^root]\n\n[^root]: note");
    const ids = [...root.querySelectorAll("[id]")].map((element) => element.id);
    for (const id of ids)
      expect(id === "footnote-label" || id.startsWith("user-content-")).toBe(true);
  });
});

describe("Markdown link targets", () => {
  test("another site opens with no opener and no referrer", () => {
    const link = html("[a](https://example.com/x)").querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    expect(link.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  test("a scheme-relative or backslash link does not reach another origin", () => {
    expect(html("[a](//evil.example/x)").querySelector("a")).toBeNull();
    for (const source of ["[a](/\\evil.example/x)", "[a](\\\\evil.example/x)"]) {
      const href = html(source).querySelector("a")?.getAttribute("href") ?? "";
      expect(new URL(href, "https://git.example/acme/infra").origin).toBe("https://git.example");
    }
  });

  test("a relative link in a file goes through the resolver; one that climbs out stays relative", () => {
    const resolveLink = (href: string) =>
      href === "docs/a.md" ? "/acme/infra/blob/main/docs/a.md" : null;
    const root = html("[a](docs/a.md) [b](../../../../evil)", { resolveLink });
    const [first, second] = [...root.querySelectorAll("a")];
    expect(first!.getAttribute("href")).toBe("/acme/infra/blob/main/docs/a.md");
    expect(new URL(second!.getAttribute("href")!, "https://git.example/a/b/").origin).toBe(
      "https://git.example",
    );
  });
});

describe("Markdown images", () => {
  test("load lazily over https only, with no referrer", () => {
    const root = html("![a](https://example.com/a.png) ![b](http://example.com/b.png)");
    const images = [...root.querySelectorAll("img")];
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe("https://example.com/a.png");
    expect(images[0]!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(images[0]!.getAttribute("loading")).toBe("lazy");
    expect(root.textContent).toContain("b");
  });

  test("a relative image goes through the resolver", () => {
    const root = html("![a](img/a.png)", { resolveImage: () => "/acme/infra/raw/main/img/a.png" });
    expect(root.querySelector("img")!.getAttribute("src")).toBe("/acme/infra/raw/main/img/a.png");
  });
});

describe("Markdown limits", () => {
  test("nesting depth is estimated per line, from markers and the indentation before them", () => {
    expect(containerDepth("plain\n    indented code\n")).toBe(0);
    expect(containerDepth("> a\n>> b\n> > > c")).toBe(3);
    expect(containerDepth("- a\n  - b\n    - c")).toBe(3);
    expect(containerDepth("1. a\n   2) b")).toBe(2);
    expect(containerDepth("- - - - a")).toBe(4);
    expect(containerDepth("-not a list\n*emphasis*")).toBe(0);
    expect(containerDepth(">".repeat(20_000))).toBe(20_000);
  });

  test.each([
    [">".repeat(20_000) + " a"],
    ["- ".repeat(5_000) + "a"],
    [Array.from({ length: 400 }, (_, index) => `${"  ".repeat(index)}- a`).join("\n")],
    ["x".repeat(600_000)],
  ])("too deep or too long is shown as plain text at once (%#)", (source) => {
    expect(withinMarkdownLimits(source)).toBe(false);
    const started = performance.now();
    const { container } = render(<Markdown source={source} />);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(container.querySelector("blockquote, ul, ol")).toBeNull();
    expect(container.textContent).toBe(source);
  });

  test("ordinary nesting renders", () => {
    const source = Array.from(
      { length: MARKDOWN_MAX_DEPTH - 2 },
      (_, i) => `${"  ".repeat(i)}- a`,
    ).join("\n");
    expect(withinMarkdownLimits(source)).toBe(true);
  });

  test("a table that pads to too many cells is shown as its source", () => {
    const source = `${"|a".repeat(1_000)}|\n${"|-".repeat(1_000)}|\n${"a\n".repeat(1_000)}`;
    const started = performance.now();
    const root = html(source);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(root.querySelector("table")).toBeNull();
    expect(root.querySelector("pre")!.textContent).toContain("|a|a|a");
  });

  test("an ordinary table is still a table", () => {
    const root = html("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(screen.getByRole("table")).toBe(root.querySelector("table"));
  });

  test("a renderer failure shows the text instead of taking the page down", async () => {
    vi.resetModules();
    vi.doMock("../MarkdownBody", () => ({
      default: () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
    }));
    const { Markdown: Isolated } = await import("../Markdown");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, findByText } = render(<Isolated source="**still readable**" />);
    // Let the lazy renderer load and throw; without the boundary the error escapes the tree.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await findByText("**still readable**")).toBeTruthy();
    expect(container.querySelector("strong")).toBeNull();
    quiet.mockRestore();
    vi.doUnmock("../MarkdownBody");
  });
});
