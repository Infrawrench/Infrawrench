import { Component, Suspense, lazy, type ReactNode } from "react";
import { withinMarkdownLimits } from "../lib/markdown-limits";
import type { MarkdownProps } from "./MarkdownBody";

const MarkdownBody = lazy(() => import("./MarkdownBody"));

function PlainText({ source, className }: { source: string; className?: string | undefined }) {
  return <div className={`markdown whitespace-pre-wrap ${className ?? ""}`}>{source}</div>;
}

/**
 * Shows the source as text if rendering it throws, rather than taking the
 * page down with it. Keyed by the source, so a new source gets another try.
 */
class RenderOrText extends Component<
  { source: string; className?: string | undefined; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return <PlainText source={this.props.source} className={this.props.className} />;
    }
    return this.props.children;
  }
}

/**
 * GitHub-flavoured Markdown: a README, an issue's text, a comment. Raw HTML
 * in the source is shown as text, never rendered. Loaded on demand, so the
 * source shows as plain text for the moment before the renderer arrives.
 * Past the limits of `lib/markdown-limits.ts` it stays plain text.
 */
export function Markdown(props: MarkdownProps) {
  if (!withinMarkdownLimits(props.source)) {
    return <PlainText source={props.source} className={props.className} />;
  }
  return (
    <RenderOrText key={props.source} source={props.source} className={props.className}>
      <Suspense fallback={<PlainText source={props.source} className={props.className} />}>
        <MarkdownBody {...props} />
      </Suspense>
    </RenderOrText>
  );
}

export type { MarkdownProps };
