import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { T, Var, useGT } from "gt-react";
import { apiGet, apiPost } from "@/lib/api";

interface InviteDetails {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  organizationId: string;
  organizationName: string;
}

export const Route = createFileRoute("/invite/$token")({
  component: InviteAcceptPage,
});

function InviteAcceptPage() {
  const gt = useGT();
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<InviteDetails>(`/api/invitations/by-token/${token}`)
      .then(setInvite)
      .catch((e) => setError(e instanceof Error ? e.message : gt("Invitation not found")))
      .finally(() => setLoading(false));
  }, [token, gt]);

  async function handleAccept() {
    setAccepting(true);
    setError(null);
    try {
      const result = await apiPost<{ organization: { id: string; displayName: string } }>(
        "/api/invitations/accept",
        { token },
      );
      void navigate({ to: "/org/$orgId", params: { orgId: result.organization.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to accept invitation"));
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface-tertiary">
        <div className="animate-pulse text-sm">{gt("Loading…")}</div>
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2">{gt("Invalid invitation")}</h1>
          <p className="text-sm text-on-surface-tertiary">{error}</p>
        </div>
      </div>
    );
  }

  if (!invite) return null;

  if (invite.acceptedAt) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2">{gt("Invitation already accepted")}</h1>
          <p className="text-sm text-on-surface-tertiary mb-4">
            {gt("You're already a member of {org}.", { org: invite.organizationName })}
          </p>
          <button
            type="button"
            onClick={() =>
              void navigate({ to: "/org/$orgId", params: { orgId: invite.organizationId } })
            }
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            {gt("Go to {org}", { org: invite.organizationName })}
          </button>
        </div>
      </div>
    );
  }

  const expired = new Date(invite.expiresAt) < new Date();

  return (
    <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
      <div className="w-full max-w-md px-6 text-center">
        <h1 className="text-2xl font-bold mb-2">{gt("You've been invited")}</h1>
        <T>
          <p className="text-sm text-on-surface-tertiary mb-8">
            You've been invited to join{" "}
            <Var>
              <span className="text-on-surface-secondary font-medium">
                {invite.organizationName}
              </span>
            </Var>{" "}
            as a{" "}
            <Var>
              <span className="text-on-surface-secondary font-medium">{invite.role}</span>
            </Var>
            .
          </p>
        </T>

        {error && <p className="text-xs text-danger mb-4">{error}</p>}

        {expired ? (
          <p className="text-sm text-danger">{gt("This invitation has expired.")}</p>
        ) : (
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={accepting}
            className="w-full px-4 py-3 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {accepting ? gt("Joining...") : gt("Accept Invitation")}
          </button>
        )}
      </div>
    </div>
  );
}
