/**
 * The Markdown renderer's implementation. Import `Markdown` from
 * `./Markdown`, which loads this file (and react-markdown with it) on demand.
 */
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { languageOfFence, useHighlight } from "../lib/highlight";
import { limitTables } from "../lib/markdown-limits";
import { safeImageUrl, safeLinkUrl } from "../lib/safe-url";
import { AppLink } from "./AppLink";
import { CodeLine, linesOf } from "./CodeView";

export interface MarkdownProps {
  readonly source: string;
  /**
   * Where a relative link goes (`docs/runbook.md` in a README). Return null to
   * leave the link as written. Absolute URLs and anchors never reach this.
   */
  readonly resolveLink?: (href: string) => string | null;
  /** Where a relative image's bytes are. */
  readonly resolveImage?: (src: string) => string | null;
  readonly className?: string;
}

const isRelative = (url: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//") && !url.startsWith("#");

/**
 * Every URL in the source, before anything renders it: a link may go to this
 * site, a web address or `mailto:`, an image may load from this site or over
 * `https:` (`lib/safe-url.ts`). Anything else becomes empty, and the
 * components below draw it as text.
 */
export const markdownUrl = (url: string, key: string): string =>
  (key === "src" ? safeImageUrl(url) : safeLinkUrl(url, { mailto: true })) ?? "";

function Fence({ code, info }: { code: string; info: string }) {
  const text = code.replace(/\n$/, "");
  const tokens = useHighlight(text, languageOfFence(info));
  return (
    <pre>
      <code>
        {linesOf(`${text}\n`).map((line, index) => (
          <span key={index} className="block">
            <CodeLine text={line} tokens={tokens?.[index]} />
          </span>
        ))}
      </code>
    </pre>
  );
}

const textOf = (node: ReactNode): string =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : node === null || node === undefined || typeof node === "boolean"
        ? ""
        : typeof node === "number"
          ? String(node)
          : "";

export default function MarkdownBody({
  source,
  resolveLink,
  resolveImage,
  className = "",
}: MarkdownProps) {
  const components: Components = {
    a: ({ href, children, node: _node, ...rest }) => {
      if (href === undefined || href === "") return <span>{children}</span>;
      const target = isRelative(href) ? (resolveLink?.(href) ?? href) : href;
      const external = /^[a-z][a-z0-9+.-]*:/i.test(target);
      return (
        <AppLink
          {...rest}
          href={target}
          rel={external ? "noopener noreferrer nofollow" : undefined}
        >
          {children}
        </AppLink>
      );
    },
    img: ({ src, alt, node: _node, ...rest }) => {
      const url = typeof src === "string" ? src : "";
      // A refused source shows its alt text, as a broken image would.
      if (url === "") return alt ? <span>{alt}</span> : null;
      const target = isRelative(url) ? (resolveImage?.(url) ?? url) : url;
      // Another site learns the reader's address from an image, but not
      // which page of which repository it was on.
      return (
        <img
          {...rest}
          src={target}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      );
    },
    pre: ({ children }) => <>{children}</>,
    code: ({ className: language, children, node }) => {
      const code = textOf(children);
      // A fenced block is a `code` inside a `pre`; inline code has no newline
      // and no language class.
      const fenced =
        language !== undefined ||
        code.includes("\n") ||
        (node?.position !== undefined && node.position.start.line !== node.position.end.line);
      if (!fenced) return <code>{children}</code>;
      return <Fence code={code} info={(language ?? "").replace(/^language-/, "")} />;
    },
    table: ({ children, node: _node, ...rest }) => (
      <div className="overflow-x-auto">
        <table {...rest}>{children}</table>
      </div>
    ),
  };
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, limitTables(source)]}
        urlTransform={markdownUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
