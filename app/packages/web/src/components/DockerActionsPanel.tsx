import { DockerActionsPanel as SharedDockerActionsPanel } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";

interface Props {
  accountId: string;
  containerId: string;
}

export function DockerActionsPanel({ accountId, containerId }: Props) {
  return (
    <SharedDockerActionsPanel
      containerId={containerId}
      onCommand={(op, params) => apiPost("/api/docker/command", { accountId, op, params })}
    />
  );
}
