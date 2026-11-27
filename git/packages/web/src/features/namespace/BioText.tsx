import { autolink } from "../../lib/autolink";
import { showBidi } from "../../lib/bidi";

/**
 * A bio: one paragraph of plain text, its web addresses linked. Every part
 * is a text node, so nothing in it is ever read as markup.
 */
export function BioText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p className={`break-words ${className}`}>
      {autolink(text).map((part, index) =>
        part.href === null ? (
          showBidi(part.text)
        ) : (
          <a
            key={index}
            href={part.href}
            rel="noopener noreferrer nofollow ugc"
            className="text-accent underline underline-offset-2"
          >
            {showBidi(part.text)}
          </a>
        ),
      )}
    </p>
  );
}
