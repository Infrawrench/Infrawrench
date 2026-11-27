/**
 * The tags against the UI's real shell (`git/packages/web/index.html`):
 * every tag the Worker sets is there exactly once, and the values the shell
 * is built with are the site's own, so a page served without the Worker's
 * edits (the dev server, a failed lookup) still says the right thing.
 *
 * `HTMLRewriter` is Cloudflare's; here a stand-in finds each tag the way
 * its selector would and makes the edit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { genericMeta, pageMeta } from "../meta";
import { pageOf } from "../pages";
import { type Rewriter, type ShellEdit, rewriteShell, shellEdits } from "../shell";
import { FIXTURES } from "./fixtures";

const SHELL = readFileSync(new URL("../../../../web/index.html", import.meta.url), "utf8");

const unescape = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The tags `selector` names in `html`: `title`, or `tag[attr="value"]`. */
const find = (html: string, selector: string): RegExpMatchArray[] => {
  if (selector === "title") return [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)];
  const parsed = /^(\w+)\[(\w+)="([^"]+)"\]$/.exec(selector);
  if (!parsed) throw new Error(`unexpected selector ${selector}`);
  const [, tag, attribute, value] = parsed;
  return [...html.matchAll(new RegExp(`<${tag}\\s[^>]*>`, "g"))].filter((match) =>
    new RegExp(`\\s${attribute}="${value!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(match[0]),
  );
};

const valueOf = (html: string, edit: ShellEdit): string => {
  const [match] = find(html, edit.selector);
  if (!match) throw new Error(`no ${edit.selector}`);
  if ("text" in edit) return match[1]!;
  return unescape(new RegExp(`\\s${edit.attribute}="([^"]*)"`).exec(match[0])![1]!);
};

/** Makes the edits a rewriter is told to, on the shell's text. */
const fakeRewriter = (): Rewriter & { readonly edits: ShellEdit[] } => {
  const edits: ShellEdit[] = [];
  const rewriter = {
    edits,
    on(selector: string, handlers: Parameters<Rewriter["on"]>[1]) {
      handlers.element({
        setAttribute: (attribute, value) => edits.push({ selector, attribute, value }),
        setInnerContent: (text) => edits.push({ selector, text }),
      });
      return rewriter;
    },
    transform(response: Response): Response {
      const body = response.text().then((html) => {
        for (const edit of edits) {
          const [match] = find(html, edit.selector);
          if (!match) continue;
          html =
            "text" in edit
              ? html.replace(match[0], `<title>${escape(edit.text)}</title>`)
              : html.replace(
                  match[0],
                  match[0].replace(
                    new RegExp(`(\\s${edit.attribute}=")[^"]*"`),
                    `$1${escape(edit.value)}"`,
                  ),
                );
        }
        return html;
      });
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(await body));
            controller.close();
          },
        }),
        { status: response.status, headers: response.headers },
      );
    },
  };
  return rewriter;
};

describe("the shell", () => {
  it("has every tag the Worker sets, once", async () => {
    for (const edit of shellEdits(await genericMeta("https://git.infrawrench.com"))) {
      expect(find(SHELL, edit.selector), edit.selector).toHaveLength(1);
    }
  });

  it("is built with the site's own tags", async () => {
    for (const edit of shellEdits(await genericMeta("https://git.infrawrench.com"))) {
      const wanted = "text" in edit ? edit.text : edit.value;
      expect(valueOf(SHELL, edit), edit.selector).toBe(wanted);
    }
  });

  it("takes a page's tags, and nothing else changes", async () => {
    const page = pageOf("/acme/platform-infra/issues/412");
    const tags = await pageMeta(page, FIXTURES["issue"]!, "https://git.infrawrench.com");
    const shell = new Response(SHELL, {
      headers: { "content-type": "text/html", etag: '"abc"', "content-length": "10" },
    });
    const answer = rewriteShell(shell, shellEdits(tags), fakeRewriter());
    expect(answer.headers.get("etag")).toBeNull();
    expect(answer.headers.get("content-length")).toBeNull();
    const html = await answer.text();
    for (const edit of shellEdits(tags)) {
      expect(valueOf(html, edit), edit.selector).toBe("text" in edit ? edit.text : edit.value);
    }
    expect(html.replace(/<head>[\s\S]*<\/head>/, "")).toBe(
      SHELL.replace(/<head>[\s\S]*<\/head>/, ""),
    );
  });

  it("hands a repository's words to the rewriter as values, never as markup", async () => {
    const facts = FIXTURES["repository"]!;
    if (facts.kind !== "repository") throw new Error("fixture");
    const hostile = '"><script>alert(1)</script><meta x="';
    const tags = await pageMeta(
      pageOf("/acme/platform-infra"),
      { ...facts, repository: { ...facts.repository, description: hostile } },
      "https://git.infrawrench.com",
    );
    const rewriter = fakeRewriter();
    await rewriteShell(new Response(SHELL), shellEdits(tags), rewriter).text();
    // Every edit is an attribute value or a title's text: `HTMLRewriter` escapes both.
    for (const edit of rewriter.edits) {
      expect("text" in edit ? edit.selector : edit.attribute).toMatch(/^(title|content|href)$/);
    }
    expect(rewriter.edits.some((edit) => "value" in edit && edit.value.includes(hostile))).toBe(
      true,
    );
  });
});
