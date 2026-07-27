import { useLocalSearchParams } from "expo-router";
import { SftpBrowserScreen } from "@/features/files/SftpBrowserScreen";

export default function FilesRoute() {
  // `sshHost` / `sshUsername` are set when the caller is an `sshEndpoint`
  // resource, which needs an org SSH key picked before any SFTP call.
  const { accountId, sshHost, sshUsername } = useLocalSearchParams<{
    accountId: string;
    sshHost?: string;
    sshUsername?: string;
  }>();
  return (
    <SftpBrowserScreen accountId={accountId} sshHost={sshHost} defaultSshUsername={sshUsername} />
  );
}
