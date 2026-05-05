import { DockerActionsPanel as SharedDockerActionsPanel } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface Props {
  accountId: string;
  containerId: string;
}

export function DockerActionsPanel({ accountId, containerId }: Props) {
  const orgId = useOrgId();
  return (
    <SharedDockerActionsPanel
      containerId={containerId}
      onCommand={(op, params) =>
        apiPost(`/api/org/${orgId}/docker/command`, { accountId, op, params })
      }
    />
  );
}
