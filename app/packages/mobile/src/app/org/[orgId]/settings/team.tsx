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
import type { InvitationSummary, TeamMember } from "@infrawrench/client-core";

export default function TeamScreen() {
  const { api, orgId } = useOrgApi();

  const members = useQuery({
    queryKey: ["team-members", orgId],
    queryFn: () => api.org<TeamMember[]>(orgId, "/team/members"),
  });
  const invitations = useQuery({
    queryKey: ["team-invitations", orgId],
    queryFn: () => api.org<InvitationSummary[]>(orgId, "/team/invitations"),
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
      <Card list>
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
          <Card list>
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
