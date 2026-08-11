function getActionLabel(url: string): string {
  try {
    const { hostname } = new URL(url);
    if (
      hostname.includes("console.developers.google.com") ||
      hostname.includes("console.cloud.google.com")
    ) {
      return "Open Google Cloud Console";
    }
    return `Open ${hostname}`;
  } catch {
    return "Open link";
  }
}

function parseErrorContent(message: string): { lines: string[]; links: string[] } {
  const lines: string[] = [];
  const links: string[] = [];

  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^https?:\/\/\S+$/i.test(line)) {
      links.push(line);
      continue;
    }
    lines.push(line);
  }

  return { lines, links };
}

export interface ErrorNoticeProps {
  message: string;
  className?: string;
  textClassName?: string;
  /** Handler for opening links. Defaults to window.open. */
  onOpenLink?: (url: string) => void;
}

export function ErrorNotice({
  message,
  className = "",
  textClassName = "",
  onOpenLink,
}: ErrorNoticeProps) {
  const { lines, links } = parseErrorContent(message);

  function openLink(url: string) {
    if (onOpenLink) {
      onOpenLink(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div className={className}>
      <div className={`space-y-1 ${textClassName}`.trim()}>
        {lines.map((line, idx) => (
          <p key={`${idx}:${line}`}>{line}</p>
        ))}
      </div>
      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((link) => (
            <button
              key={link}
              type="button"
              onClick={() => openLink(link)}
              className="inline-flex items-center rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-red-500/20 transition-colors"
            >
              {getActionLabel(link)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
