/** Everything below is for text that may have come from a vendor document. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** One line, short, with nothing a terminal or a log parser would act on. */
export function oneLine(text: string, limit = 500): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").replace(CONTROL, "").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

/** A fence the text cannot close, because no run of backticks in it is as long. */
export function fenced(text: string, limit = 12_000): string {
  const clean = stripAnsi(text).replaceAll("\r\n", "\n").replace(CONTROL, "");
  const body = clean.length > limit ? `...(truncated)\n${clean.slice(-limit)}` : clean;
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${body.trimEnd()}\n${fence}`;
}

/** Inline code. Backticks cannot be escaped inside a span, so they are removed. */
export function codeSpan(text: string): string {
  return `\`${oneLine(text, 300).replaceAll("`", "'") || " "}\``;
}
