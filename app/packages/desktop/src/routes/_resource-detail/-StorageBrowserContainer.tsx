import type { DetailViewSchema, PluginClient } from "@infrawrench/plugin-base";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import { invoke } from "../../lib/invoke";

interface StorageBrowserContainerProps {
  schema: DetailViewSchema;
  pluginId: string;
  hasStorageToken: boolean;
  getClient: () => PluginClient;
}

export function StorageBrowserContainer({
  schema,
  pluginId,
  hasStorageToken,
  getClient,
}: StorageBrowserContainerProps) {
  if (!schema.storageBrowser) return null;
  const bucketName = schema.storageBrowser.bucketName;
  return (
    <FileBrowser
      formatError={formatErrorMessage}
      bucketName={bucketName}
      onList={(prefix) => getClient().listStorageObjects!(bucketName, prefix)}
      onUpload={(bucket, key, file, onProgress) =>
        getClient().uploadStorageObject!(bucket, key, file, onProgress)
      }
      onMakeFolder={(bucket, key) => getClient().makeStorageFolder!(bucket, key)}
      onDelete={(bucket, key) => getClient().deleteStorageObject!(bucket, key)}
      {...(hasStorageToken
        ? {
            onBatchDownload: async (keys: string[]) => {
              const accessToken = await getClient().getStorageAccessToken!();
              const result = await invoke<{ canceled?: boolean; filePaths?: string[] }>(
                "show_open_dialog",
                { properties: ["openDirectory"], title: "Choose download destination" },
              );
              if (result.canceled || !result.filePaths?.[0]) return;
              const destFolder = result.filePaths[0];
              await invoke("storage_download_batch", {
                pluginId,
                bucket: bucketName,
                keys,
                destFolder,
                accessToken,
              });
            },
          }
        : {})}
    />
  );
}
