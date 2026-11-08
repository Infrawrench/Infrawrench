import type { DetailViewSchema, HostPluginClient } from "@infrawrench/plugin-base";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import { DesktopRpcClient, runRpc } from "../../lib/rpc/client";
import { showOpenDialog } from "../../lib/app-shell";

interface StorageBrowserContainerProps {
  schema: DetailViewSchema;
  pluginId: string;
  hasStorageToken: boolean;
  getClient: () => HostPluginClient;
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
              const result = await showOpenDialog({
                properties: ["openDirectory"],
                title: "Choose download destination",
              });
              if (result.canceled || !result.filePaths?.[0]) return;
              const destFolder = result.filePaths[0];
              await runRpc(
                DesktopRpcClient.use((rpc) =>
                  rpc.StorageDownloadBatch({
                    pluginId,
                    bucket: bucketName,
                    keys,
                    destFolder,
                    accessToken,
                  }),
                ),
              );
            },
          }
        : {})}
    />
  );
}
