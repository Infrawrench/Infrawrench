import { ErrorNotice as SharedErrorNotice } from "@infrawrench/ui";
import { openExternalUrl } from "../lib/app-shell";

interface ErrorNoticeProps {
  message: string;
  className?: string;
  textClassName?: string;
}

async function handleOpenLink(url: string) {
  try {
    await openExternalUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function ErrorNotice({ message, className, textClassName }: ErrorNoticeProps) {
  return (
    <SharedErrorNotice
      message={message}
      {...(className !== undefined ? { className } : {})}
      {...(textClassName !== undefined ? { textClassName } : {})}
      onOpenLink={(url) => void handleOpenLink(url)}
    />
  );
}
