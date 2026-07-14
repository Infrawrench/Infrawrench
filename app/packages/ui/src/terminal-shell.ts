/**
 * Shell-quoting helpers for launching a command inside a remote SSH
 * terminal. Shared by the web (WebTerminal) and desktop (SshTerminal)
 * hosts, which previously kept identical copies.
 */

/**
 * Build the command typed into a fresh shell when a terminal opens with an
 * initial command and optional working directory ("cd <cwd> && <command>").
 */
export function buildInitialShellCommand(
  command: string | undefined,
  cwd: string | undefined,
): string {
  const trimmedCommand = command?.trim();
  if (!trimmedCommand) return "";
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) return trimmedCommand;
  return `cd ${shellQuote(trimmedCwd)} && ${trimmedCommand}`;
}

export function shellQuote(value: string): string {
  // Keep a leading `~` or `~/` bare so the shell still expands it, but
  // double-quote the remainder so spaces and metacharacters can't split
  // or inject into the command.
  if (value === "~") return "~";
  if (value.startsWith("~/")) {
    return `~/"${value.slice(2).replace(/(["\\$`])/g, "\\$1")}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
