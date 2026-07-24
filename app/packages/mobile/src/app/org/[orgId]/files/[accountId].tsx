import { useLocalSearchParams } from "expo-router";
import { SftpBrowserScreen } from "@/features/files/SftpBrowserScreen";

export default function FilesRoute() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  return <SftpBrowserScreen accountId={accountId} />;
}
