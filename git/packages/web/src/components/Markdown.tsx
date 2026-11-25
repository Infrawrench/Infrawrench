import { Suspense, lazy } from "react";
import type { MarkdownProps } from "./MarkdownBody";

const MarkdownBody = lazy(() => import("./MarkdownBody"));

/**
 * GitHub-flavoured Markdown: a README, an issue's text, a comment. Raw HTML
 * in the source is shown as text, never rendered. Loaded on demand, so the
 * source shows as plain text for the moment before the renderer arrives.
 */
export function Markdown(props: MarkdownProps) {
  return (
    <Suspense
      fallback={
        <div className={`markdown whitespace-pre-wrap ${props.className ?? ""}`}>
          {props.source}
        </div>
      }
    >
      <MarkdownBody {...props} />
    </Suspense>
  );
}

export type { MarkdownProps };
