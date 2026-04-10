import { FileBrowser } from "@infrawrench/ui";
import { formatErrorMessage } from "../lib/errors";

interface GcsBrowserPanelProps {
  bucketName: string;
  onList: (prefix: string) => Promise<import("@infrawrench/plugin-base").StorageObject[]>;
  onUpload?: (bucket: string, key: string, file: File, onProgress: (pct: number) => void) => Promise<void>;
  onMakeFolder?: (bucket: string, key: string) => Promise<void>;
  onDelete?: (bucket: string, key: string) => Promise<void>;
  onBatchDownload?: (keys: string[]) => Promise<void>;
}

export function GcsBrowserPanel(props: GcsBrowserPanelProps) {
  return <FileBrowser {...props} formatError={formatErrorMessage} />;
}
