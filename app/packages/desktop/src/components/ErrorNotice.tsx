import { ErrorNotice as SharedErrorNotice } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";

interface ErrorNoticeProps {
  message: string;
  className?: string;
  textClassName?: string;
}

export function ErrorNotice({ message, className, textClassName }: ErrorNoticeProps) {
  async function handleOpenLink(url: string) {
    try {
      await invoke("open_external_url", { url });
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <SharedErrorNotice
      message={message}
      {...(className !== undefined ? { className } : {})}
      {...(textClassName !== undefined ? { textClassName } : {})}
      onOpenLink={(url) => void handleOpenLink(url)}
    />
  );
}
