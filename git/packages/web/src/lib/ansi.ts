/**
 * Terminal output with SGR escape sequences (`ESC[31m`) as styled spans. Only
 * what CI logs use is kept: the eight colours and their bright forms as
 * foreground, bold, dim, italic and underline. Every other escape sequence
 * (cursor movement, erase, OSC titles and links, device control strings) is
 * dropped with its payload, and so are the other control characters, so a
 * log can neither carry a link nor hide text behind a terminal command.
 * Styles only ever come from the fixed set above; nothing in a log becomes a
 * CSS value or a URL.
 */

export type AnsiColor =
  "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

export interface AnsiStyle {
  readonly color: AnsiColor | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export interface AnsiSpan extends AnsiStyle {
  readonly text: string;
}

export const PLAIN: AnsiStyle = {
  color: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

const COLORS: ReadonlyArray<AnsiColor> = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

// In order: CSI sequences (ESC [ or its one-byte form, parameters, final
// byte); OSC, DCS, SOS, PM and APC strings with their payload, up to BEL, ST,
// the next ESC or the end of the line when unterminated; any other escape;
// and the remaining C0 and C1 control characters but tab and carriage return.
// Each alternative is linear: no nested repetition.
const ESCAPE =
  /(?:\u001b\[|\u009b)([0-9;:?<=>]*)([ -/]*[@-~])|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u009c|\u001b\\)?|\u001b[ -~]?|[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g;

function applyCodes(style: AnsiStyle, parameters: string): AnsiStyle {
  const codes = parameters === "" ? [0] : parameters.split(";").map((part) => Number(part) || 0);
  let next = { ...style };
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.color = COLORS[code - 30]!;
    else if (code >= 90 && code <= 97) next.color = COLORS[code - 90]!;
    else if (code === 39) next.color = null;
    else if (code === 38 || code === 48) {
      // An extended colour (`38;5;n` or `38;2;r;g;b`): skip its arguments, keep the style.
      index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
    }
  }
  return next;
}

/**
 * One line of output as spans. `style` is the style in force at the start of
 * the line (a colour set on an earlier line carries on); the style at the end
 * comes back for the next line.
 */
export function parseAnsiLine(
  line: string,
  style: AnsiStyle = PLAIN,
): { spans: AnsiSpan[]; style: AnsiStyle } {
  const spans: AnsiSpan[] = [];
  if (line.endsWith("\r")) line = line.slice(0, -1);
  let current = style;
  let last = 0;
  const push = (text: string) => {
    if (text !== "") spans.push({ ...current, text });
  };
  for (const match of line.matchAll(ESCAPE)) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === "m") current = applyCodes(current, match[1] ?? "");
  }
  // A carriage return rewrites the line: what a terminal would show is the last write.
  push(line.slice(last));
  return { spans: afterCarriageReturn(spans), style: current };
}

function afterCarriageReturn(spans: AnsiSpan[]): AnsiSpan[] {
  for (let index = spans.length - 1; index >= 0; index--) {
    const at = spans[index]!.text.lastIndexOf("\r");
    if (at < 0) continue;
    const rest = spans[index]!.text.slice(at + 1);
    const kept = spans
      .slice(index + 1)
      .map((span) => ({ ...span, text: span.text.replace(/\r/g, "") }));
    return rest === "" ? kept : [{ ...spans[index]!, text: rest }, ...kept];
  }
  return spans;
}

/** The text with every escape sequence removed, for searching and copying. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE, "");
}
