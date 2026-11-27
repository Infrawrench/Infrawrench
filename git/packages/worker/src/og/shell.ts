/**
 * A page's tags, put into the UI's shell (`git/packages/web/index.html`).
 *
 * The shell already carries every tag, with the site's own values; this
 * only sets each one's value, through `HTMLRewriter`'s `setAttribute` and
 * `setInnerContent` (as text), which escape what they are given. No HTML
 * is ever written from a repository's data: a description with `"><script>`
 * in it lands in an attribute as text.
 */
import { SITE_NAME, type PageMeta } from "./meta";

export type ShellEdit =
  | { readonly selector: string; readonly text: string }
  | { readonly selector: string; readonly attribute: string; readonly value: string };

const meta = (key: "name" | "property", name: string, value: string): ShellEdit => ({
  selector: `meta[${key}="${name}"]`,
  attribute: "content",
  value,
});

/** Every value the shell's tags take for `page`, in the order they are in the shell. */
export const shellEdits = (page: PageMeta): readonly ShellEdit[] => [
  { selector: "title", text: page.title },
  meta("name", "description", page.description),
  { selector: 'link[rel="canonical"]', attribute: "href", value: page.canonical },
  meta("property", "og:site_name", SITE_NAME),
  meta("property", "og:type", page.type),
  meta("property", "og:title", page.title),
  meta("property", "og:description", page.description),
  meta("property", "og:url", page.url),
  meta("property", "og:image", page.image.url),
  meta("property", "og:image:type", "image/png"),
  meta("property", "og:image:width", String(page.image.width)),
  meta("property", "og:image:height", String(page.image.height)),
  meta("property", "og:image:alt", page.image.alt),
  meta("name", "twitter:card", "summary_large_image"),
  meta("name", "twitter:title", page.title),
  meta("name", "twitter:description", page.description),
  meta("name", "twitter:image", page.image.url),
  meta("name", "twitter:image:alt", page.image.alt),
];

/** As much of `HTMLRewriter` as is used, so a test can stand in for it. */
export interface Rewriter {
  on(
    selector: string,
    handlers: {
      element(element: {
        setAttribute(name: string, value: string): unknown;
        setInnerContent(content: string, options: { html: boolean }): unknown;
      }): void;
    },
  ): Rewriter;
  transform(response: Response): Response;
}

/**
 * The shell with `edits` made. Its validators go: the body now differs by
 * page, so the asset layer's `ETag` for `index.html` no longer names it.
 */
export function rewriteShell(
  shell: Response,
  edits: readonly ShellEdit[],
  rewriter: Rewriter,
): Response {
  for (const edit of edits) {
    rewriter.on(edit.selector, {
      element(element) {
        if ("text" in edit) element.setInnerContent(edit.text, { html: false });
        else element.setAttribute(edit.attribute, edit.value);
      },
    });
  }
  const headers = new Headers(shell.headers);
  for (const name of ["etag", "last-modified", "content-length"]) headers.delete(name);
  headers.set("cache-control", "no-cache");
  return rewriter.transform(
    new Response(shell.body, { status: shell.status, statusText: shell.statusText, headers }),
  );
}
