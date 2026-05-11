import type { ReactNode } from "react";

export interface MongoPeerAccount {
  id: string;
  displayName: string;
}

export interface FirestoreMongoPeerShellProps {
  /** All Mongo accounts the user could link this Firestore database to. */
  accounts: MongoPeerAccount[];
  /** The currently linked account, if any. */
  linkedAccountId: string | null;
  /** True while accounts are still loading from the host's data source. */
  loading: boolean;
  /** Non-empty when account-loading or connection-string lookup failed. */
  error?: string | null;
  /**
   * When `linkedAccountId` is set but the browser still isn't ready (e.g. the
   * desktop variant is still decrypting the connection string), set this so
   * the shell shows a "Loading connection..." spinner instead of `children`.
   */
  pendingConnection?: boolean;
  onLink: (accountId: string) => void;
  onUnlink: () => void;
  /** The actual MongoDocumentBrowser, rendered once an account is linked. */
  children: ReactNode;
}

/**
 * Picker + "Linked: ... / Unlink" chrome for the Firestore Enterprise
 * MongoDB-compat browser. Same shell on desktop and web; the data-loading
 * and credential-resolution differ and stay in the host.
 */
export function FirestoreMongoPeerShell({
  accounts,
  linkedAccountId,
  loading,
  error,
  pendingConnection,
  onLink,
  onUnlink,
  children,
}: FirestoreMongoPeerShellProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
        Loading MongoDB accounts...
      </div>
    );
  }

  if (!linkedAccountId) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 border-t border-border">
        <div className="max-w-md w-full">
          <div className="text-sm text-on-surface-secondary mb-3 font-medium">
            Link a MongoDB account to browse this Enterprise database
          </div>
          <div className="text-xs text-on-surface-muted mb-4">
            Firestore Enterprise databases with MongoDB compatibility are accessed over the MongoDB
            wire protocol. Pick an account with a connection string pointing at this Firestore
            database.
          </div>
          {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
          {accounts.length === 0 ? (
            <div className="text-xs text-on-surface-muted">
              No MongoDB accounts. Add one from the sidebar first.
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onLink(a.id)}
                  className="w-full text-left px-3 py-2 rounded border border-border-strong bg-surface-overlay hover:bg-surface-sunken text-sm text-on-surface-secondary transition-colors"
                >
                  {a.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (pendingConnection) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
        {error ?? "Loading connection..."}
      </div>
    );
  }

  const linkedAccount = accounts.find((a) => a.id === linkedAccountId);

  return (
    <div className="flex flex-col flex-1 overflow-hidden border-t border-border">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface/80 border-b border-border/60">
        <span className="text-xs text-on-surface-muted">
          Linked:{" "}
          <span className="text-on-surface-secondary">
            {linkedAccount?.displayName ?? linkedAccountId}
          </span>
        </span>
        <div className="flex-1" />
        <button
          onClick={onUnlink}
          className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
        >
          Unlink
        </button>
      </div>
      {children}
    </div>
  );
}
