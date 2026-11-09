import { lazy, Suspense } from "react";

/**
 * The markdown renderer (micromark, mdast and hast, about 140 KB) is imported
 * the first time something renders markdown, not with the app (#912). The
 * dashboard's text widget would otherwise put it in every first download.
 */
const ChatMarkdown = lazy(() =>
  import("./ChatMarkdown.js").then((module) => ({ default: module.ChatMarkdown })),
);

/**
 * {@link ChatMarkdown}, loaded on first use. Until the renderer arrives the
 * text shows as it was written, so nothing jumps from empty to full.
 */
export function LazyChatMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap break-words text-sm">{text}</div>}>
      <ChatMarkdown text={text} />
    </Suspense>
  );
}
