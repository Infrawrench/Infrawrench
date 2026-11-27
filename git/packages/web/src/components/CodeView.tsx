/**
 * Source text with line numbers. Each number is an anchor (`#L12`); a click
 * selects the line and a shift-click extends the selection, which the owner
 * keeps (usually in the URL hash). An optional gutter column sits to the left
 * of the numbers, for blame, and an optional narrow one to their right, for a
 * mark on a line.
 */
import { memo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { bidiName, hasBidiControls, splitBidi } from "../lib/bidi";
import { useHighlight, type Token } from "../lib/highlight";
import { inRange, type LineRange } from "../lib/lines";

/**
 * Text of a line, with any bidirectional control written out as a marked
 * `<U+202E>` instead of silently reordering what follows it (`lib/bidi.ts`).
 */
function Visible({ text }: { text: string }): ReactNode {
  if (!hasBidiControls(text)) return text;
  return splitBidi(text).map((part, index) =>
    part.control ? (
      <span
        key={index}
        title="Bidirectional control character"
        className="rounded-sm bg-warning/15 text-warning"
      >
        {bidiName(part.text)}
      </span>
    ) : (
      part.text
    ),
  );
}

/** One line's content: its tokens when highlighted, its text otherwise. */
export const CodeLine = memo(function CodeLine({
  text,
  tokens,
}: {
  text: string;
  tokens?: ReadonlyArray<Token> | undefined;
}) {
  if (tokens === undefined || tokens.length === 0) {
    return <>{text === "" ? "\n" : <Visible text={text} />}</>;
  }
  return (
    <>
      {tokens.map((token, index) =>
        token.light === undefined && token.dark === undefined ? (
          <Visible key={index} text={token.content} />
        ) : (
          <span
            key={index}
            className={token.italic ? "tok italic" : "tok"}
            style={{ "--tl": token.light, "--td": token.dark } as CSSProperties}
          >
            <Visible text={token.content} />
          </span>
        ),
      )}
    </>
  );
});

/** The text as lines: a final newline ends the last line rather than starting an empty one. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface CodeViewProps {
  readonly text: string;
  /** A Shiki language id (`languageOfPath`), or null for plain text. */
  readonly language: string | null;
  readonly selected?: LineRange | null;
  /** A click on a line number. `extend` is a shift-click. */
  readonly onSelectLine?: (line: number, extend: boolean) => void;
  /** A cell to the left of each line number. Return null for a line that continues the cell above. */
  readonly gutter?: (line: number) => ReactNode;
  /** What marks a line, in a narrow column between its number and its text. Null for no mark. */
  readonly marker?: ((line: number) => ReactNode) | undefined;
  /** A name for the table, read to screen readers. */
  readonly label: string;
  readonly wrap?: boolean;
}

export function CodeView({
  text,
  language,
  selected = null,
  onSelectLine,
  gutter,
  marker,
  label,
  wrap = false,
}: CodeViewProps) {
  const tokens = useHighlight(text, language);
  const lines = linesOf(text);
  const click = (event: MouseEvent<HTMLAnchorElement>, line: number) => {
    if (!onSelectLine || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    onSelectLine(line, event.shiftKey);
  };
  return (
    <div className="code-surface overflow-x-auto">
      <table
        aria-label={label}
        className="w-full border-collapse font-mono text-xs leading-5 [tab-size:4]"
      >
        <tbody>
          {lines.map((line, index) => {
            const number = index + 1;
            const highlighted = inRange(selected, number);
            return (
              <tr key={number} className={highlighted ? "bg-warning/15" : undefined}>
                {gutter ? gutter(number) : null}
                <td className="w-px select-none whitespace-nowrap p-0 text-right align-top text-on-surface-faint">
                  <a
                    id={`L${number}`}
                    href={`#L${number}`}
                    aria-label={`Line ${number}`}
                    onClick={(event) => click(event, number)}
                    className="block scroll-mt-24 px-3 hover:text-on-surface"
                  >
                    {number}
                  </a>
                </td>
                {marker ? <td className="w-4 min-w-4 p-0 align-top">{marker(number)}</td> : null}
                <td
                  className={`p-0 pr-4 align-top text-on-surface ${
                    wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                  }`}
                >
                  <CodeLine text={line} tokens={tokens?.[index]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
