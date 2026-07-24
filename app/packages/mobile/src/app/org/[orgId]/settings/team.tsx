import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
} from "@/components/ui";

/** Shape of GET /api/org/:orgId/team/members (web api/routes/team.ts). */
interface TeamMember {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  roleId: string | null;
  roleName: string | null;
  roleSystemKey: string | null;
  createdAt: string;
}

/** Shape of GET /api/org/:orgId/team/invitations. */
interface Invitation {
  id: string;
  email: string;
  role: string;
  roleId: string | null;
  roleName: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export default function TeamScreen() {
  const { api, orgId } = useOrgApi();

  const members = useQuery({
    queryKey: ["team-members", orgId],
    queryFn: () => api.org<TeamMember[]>(orgId, "/team/members"),
  });
  const invitations = useQuery({
    queryKey: ["team-invitations", orgId],
    queryFn: () => api.org<Invitation[]>(orgId, "/team/invitations"),
  });

  if (members.isLoading) return <LoadingView />;
  if (members.isError) {
    return (
      <ErrorView
        message={members.error instanceof Error ? members.error.message : "Failed to load"}
        onRetry={() => void members.refetch()}
      />
    );
  }

  const memberList = members.data ?? [];
  const pendingInvites = (invitations.data ?? []).filter((i) => !i.acceptedAt);

  return (
    <Screen
      onRefresh={() => {
        void members.refetch();
        void invitations.refetch();
      }}
      refreshing={members.isRefetching}
    >
      <SectionTitle>Members</SectionTitle>
      <Card>
        {memberList.length === 0 ? (
          <EmptyView message="No members found." />
        ) : (
          memberList.map((m) => (
            <Row
              key={m.id}
              title={m.displayName ?? m.email}
              subtitle={`${m.email} · ${m.roleName ?? m.role}`}
            />
          ))
        )}
      </Card>

      {pendingInvites.length > 0 && (
        <>
          <SectionTitle>Pending invitations</SectionTitle>
          <Card>
            {pendingInvites.map((i) => (
              <Row
                key={i.id}
                title={i.email}
                subtitle={`${i.roleName ?? i.role} · expires ${new Date(i.expiresAt).toLocaleDateString()}`}
              />
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}
