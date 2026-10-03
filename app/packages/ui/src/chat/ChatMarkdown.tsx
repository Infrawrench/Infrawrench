import { createContext, useContext } from "react";
import { useGT } from "gt-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** True inside a rendered link, so an image there does not nest a second `<a>`. */
const InsideLink = createContext(false);

/**
 * Stand-in for a markdown image. An `<img>` would be fetched the moment the
 * message renders, and its URL is chosen by the model: a prompt-injected reply
 * can put a secret it just read into the query string and leak it with no
 * click at all, on web and desktop alike. So an image renders as a link to its
 * URL instead, labelled with its alt text, and nothing is requested until the
 * user chooses to open it.
 */
function ImagePlaceholder({ src, alt }: { src?: string | undefined; alt?: string | undefined }) {
  const gt = useGT();
  const insideLink = useContext(InsideLink);
  const label = gt("Image: {label}", { label: alt || src || gt("untitled") });
  // react-markdown's default urlTransform has already blanked any src that is
  // not http(s), mailto or relative, so an empty src means "nothing to open".
  if (insideLink || !src) {
    return <span className="text-on-surface-muted italic">[{label}]</span>;
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      title={src}
      className="text-info hover:underline"
    >
      [{label}]
    </a>
  );
}

/**
 * Markdown renderer for assistant chat messages, styled to the app's chat
 * scale. react-markdown emits no raw HTML by default, and images never load
 * (see {@link ImagePlaceholder}), so model output is safe to render directly.
 */
export function ChatMarkdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="text-sm text-on-surface-secondary break-words space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-info hover:underline">
              <InsideLink.Provider value={true}>{children}</InsideLink.Provider>
            </a>
          ),
          img: ({ src, alt }) => (
            <ImagePlaceholder src={typeof src === "string" ? src : undefined} alt={alt} />
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-on-surface">{children}</strong>
          ),
          h1: ({ children }) => <h1 className="text-base font-semibold mt-3">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold mt-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-2">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-on-surface-muted">
              {children}
            </blockquote>
          ),
          pre: ({ children }) => (
            <pre className="bg-surface-overlay border border-border rounded-lg p-3 overflow-x-auto text-xs">
              {children}
            </pre>
          ),
          code: ({ className, children }) =>
            // Block code lives inside our styled <pre>; inline code gets its
            // own chip. react-markdown passes a language-* className only for
            // fenced blocks.
            className ? (
              <code className={`font-mono ${className}`}>{children}</code>
            ) : (
              <code className="font-mono text-[0.9em] bg-surface-overlay border border-border rounded px-1 py-0.5">
                {children}
              </code>
            ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th scope="col" className="border border-border px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
          hr: () => <hr className="border-border" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
