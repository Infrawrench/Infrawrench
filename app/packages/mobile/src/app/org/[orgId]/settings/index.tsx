import { useRouter } from "expo-router";
import { useAuth, useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, Row, Screen, SectionTitle } from "@/components/ui";

export default function SettingsScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const { email, signOut } = useAuth();

  const go = (path: string) => () => router.push(`/org/${orgId}/settings/${path}`);

  return (
    <Screen>
      <SectionTitle>Organization</SectionTitle>
      <Card list>
        <Row title="Team" subtitle="Members and pending invitations" onPress={go("team")} />
        <Row title="API keys" subtitle="View and revoke API keys" onPress={go("api-keys")} />
        <Row title="Audit log" subtitle="Recent activity in this org" onPress={go("audit-log")} />
        <Row
          title="Notifications"
          subtitle="Push preferences and devices"
          onPress={go("notifications")}
        />
        <Row title="SSH keys" subtitle="Org SSH keys" onPress={go("ssh-keys")} />
        <Row title="Billing" subtitle="Plan and seats" onPress={go("billing")} />
      </Card>

      <SectionTitle>Account</SectionTitle>
      <Card list>
        <Row
          title={email ?? "Signed in"}
          subtitle="Profile, password, two-factor, sessions"
          onPress={go("account")}
        />
        <Row title="Switch organization" onPress={() => router.push("/select-org")} />
      </Card>
      <Button
        label="Sign out"
        variant="danger"
        onPress={() => {
          void (async () => {
            await signOut();
            router.replace("/sign-in");
          })();
        }}
      />
    </Screen>
  );
}
