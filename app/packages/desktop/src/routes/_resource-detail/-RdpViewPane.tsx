import { useState } from "react";
import { RdpViewer } from "../../components/RdpViewer";
import { RdpConnectPanel, type RdpConnection } from "../../components/RdpConnectPanel";

interface RdpViewPaneProps {
  rdpHost: string | null;
  rdpDefaultUsername: string | null;
}

export function RdpViewPane({ rdpHost, rdpDefaultUsername }: RdpViewPaneProps) {
  const [connection, setConnection] = useState<RdpConnection | null>(null);

  if (!rdpHost) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <div className="animate-pulse text-sm text-on-surface-muted">
          Waiting for an RDP address…
        </div>
        <div className="text-xs text-on-surface-faint">
          The machine may still be starting up. This view refreshes automatically.
        </div>
      </div>
    );
  }

  if (!connection) {
    return (
      <RdpConnectPanel
        host={rdpHost}
        defaultUsername={rdpDefaultUsername}
        onConnect={setConnection}
      />
    );
  }

  return (
    <RdpViewer
      host={rdpHost}
      port={3389}
      username={connection.username}
      password={connection.password}
      {...(connection.domain ? { domain: connection.domain } : {})}
    />
  );
}
