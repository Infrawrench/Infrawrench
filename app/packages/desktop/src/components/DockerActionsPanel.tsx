import { DockerActionsPanel as SharedDockerActionsPanel } from "@infrawrench/ui";
import { dockerCommand } from "../lib/sql-drivers";

interface Props {
  containerId: string;
  driverId: string;
  dockerHost: string;
}

export function DockerActionsPanel({ containerId, driverId, dockerHost }: Props) {
  return (
    <SharedDockerActionsPanel
      containerId={containerId}
      onCommand={(op, params) => dockerCommand(driverId, dockerHost, op, params)}
    />
  );
}
