/** Escape text for a Markdown hover: names come from providers and users. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

/** A `command:` link a trusted MarkdownString can run. */
export function commandLink(label: string, command: string, args: unknown[]): string {
  return `[${escapeMarkdown(label)}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}
