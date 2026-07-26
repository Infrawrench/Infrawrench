import { useState } from "react";
import { Alert, Image, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  challengeAuthFactor,
  confirmEmailChange,
  createPasswordResetLink,
  deleteAuthFactor,
  describeUserAgent,
  fetchProfile,
  formatAuthMethod,
  formatProvider,
  listAuthFactors,
  listUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
  startEmailChange,
  startTotpEnrollment,
  updateProfile,
  verifyTotpEnrollment,
  type PendingEmailChange,
  type TotpEnrollment,
} from "@infrawrench/client-core";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  Button,
  Card,
  ErrorView,
  LoadingView,
  Row,
  RowGroup,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Personal account settings — the mobile mirror of the web app's
 * Settings → General. Same `/api/profile` contract, same capabilities:
 * name, password reset, TOTP two-factor, and active sessions.
 */
export default function AccountScreen() {
  const { api } = useAuth();
  const queryClient = useQueryClient();

  const profile = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile(api) });
  const factors = useQuery({ queryKey: ["profile", "mfa"], queryFn: () => listAuthFactors(api) });
  const sessions = useQuery({
    queryKey: ["profile", "sessions"],
    queryFn: () => listUserSessions(api),
  });

  const [firstName, setFirstName] = useState<string | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [pendingEmail, setPendingEmail] = useState<PendingEmailChange | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [code, setCode] = useState("");

  const failed = (title: string) => (e: unknown) =>
    Alert.alert(title, e instanceof Error ? e.message : "Unknown error");

  const saveName = useMutation({
    mutationFn: () =>
      updateProfile(api, {
        firstName: firstName ?? profile.data?.firstName ?? "",
        lastName: lastName ?? profile.data?.lastName ?? "",
      }),
    onSuccess: async () => {
      setFirstName(null);
      setLastName(null);
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: failed("Save failed"),
  });

  const sendEmailCode = useMutation({
    mutationFn: () => startEmailChange(api, newEmail.trim()),
    onSuccess: (result) => {
      setEmailCode("");
      setPendingEmail(result);
    },
    onError: failed("Couldn't send the code"),
  });

  const confirmEmail = useMutation({
    mutationFn: () => confirmEmailChange(api, emailCode.trim()),
    onSuccess: async () => {
      setPendingEmail(null);
      setEmailCode("");
      setNewEmail("");
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: failed("That code isn't valid"),
  });

  const changePassword = useMutation({
    mutationFn: () => createPasswordResetLink(api),
    onSuccess: (url) => {
      if (url) void WebBrowser.openBrowserAsync(url);
    },
    onError: failed("Couldn't open password reset"),
  });

  const startEnrollment = useMutation({
    mutationFn: () => startTotpEnrollment(api),
    onSuccess: (result) => {
      setCode("");
      setEnrollment(result);
    },
    onError: failed("Couldn't start setup"),
  });

  const confirmEnrollment = useMutation({
    mutationFn: async () => {
      if (!enrollment) return;
      await verifyTotpEnrollment(api, enrollment.factorId, enrollment.challengeId, code);
    },
    onSuccess: async () => {
      setEnrollment(null);
      setCode("");
      await queryClient.invalidateQueries({ queryKey: ["profile", "mfa"] });
    },
    onError: async (e) => {
      failed("Verification failed")(e);
      // The challenge is spent whether or not the code matched — swap in a
      // fresh one so a retry isn't rejected for the wrong reason.
      if (!enrollment) return;
      const challengeId = await challengeAuthFactor(api, enrollment.factorId).catch(() => null);
      if (challengeId) setEnrollment({ ...enrollment, challengeId });
    },
  });

  const cancelEnrollment = useMutation({
    mutationFn: async () => {
      if (enrollment) await deleteAuthFactor(api, enrollment.factorId);
    },
    onSettled: () => {
      setEnrollment(null);
      setCode("");
    },
  });

  const removeFactor = useMutation({
    mutationFn: (factorId: string) => deleteAuthFactor(api, factorId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profile", "mfa"] }),
    onError: failed("Remove failed"),
  });

  const revokeOne = useMutation({
    mutationFn: (sessionId: string) => revokeUserSession(api, sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profile", "sessions"] }),
    onError: failed("Sign out failed"),
  });

  const revokeOthers = useMutation({
    mutationFn: () => revokeOtherUserSessions(api),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profile", "sessions"] }),
    onError: failed("Sign out failed"),
  });

  if (profile.isLoading) return <LoadingView />;
  if (profile.isError || !profile.data) {
    return (
      <ErrorView
        message={profile.error instanceof Error ? profile.error.message : "Failed to load"}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const me = profile.data;
  const otherSessions = (sessions.data ?? []).filter((s) => !s.current);

  return (
    <Screen
      onRefresh={() => {
        void profile.refetch();
        void factors.refetch();
        void sessions.refetch();
      }}
      refreshing={profile.isRefetching}
    >
      <SectionTitle>Profile</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          {me.profilePictureUrl ? (
            <Image source={{ uri: me.profilePictureUrl }} style={styles.avatar} />
          ) : null}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.value}>{me.email}</Text>
            <Text
              style={{ color: me.emailVerified ? colors.success : colors.warning, fontSize: 12 }}
            >
              {me.emailVerified ? "Verified" : "Unverified"}
            </Text>
          </View>
        </View>

        <Text style={styles.label}>First name</Text>
        <TextInput
          style={styles.input}
          value={firstName ?? me.firstName ?? ""}
          onChangeText={setFirstName}
          placeholder="First name"
          placeholderTextColor={colors.textFaint}
        />
        <Text style={styles.label}>Last name</Text>
        <TextInput
          style={styles.input}
          value={lastName ?? me.lastName ?? ""}
          onChangeText={setLastName}
          placeholder="Last name"
          placeholderTextColor={colors.textFaint}
        />
        {me.identities.length > 0 && (
          <Text style={styles.hint}>
            Connected accounts: {me.identities.map((i) => formatProvider(i.provider)).join(", ")}
          </Text>
        )}
        <Button
          label={saveName.isPending ? "Saving…" : "Save name"}
          disabled={saveName.isPending || (firstName === null && lastName === null)}
          onPress={() => saveName.mutate()}
        />
      </Card>

      <SectionTitle>Email address</SectionTitle>
      <Card>
        {pendingEmail ? (
          <>
            <Text style={styles.hint}>
              Enter the code sent to {pendingEmail.newEmail}. Your account stays on {me.email} until
              you do.
            </Text>
            <TextInput
              style={[styles.input, { letterSpacing: 4 }]}
              value={emailCode}
              onChangeText={(next) => setEmailCode(next.replace(/\s/g, ""))}
              placeholder="123456"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
            />
            <Button
              label={confirmEmail.isPending ? "Confirming…" : "Confirm new email"}
              disabled={confirmEmail.isPending || emailCode.trim().length === 0}
              onPress={() => confirmEmail.mutate()}
            />
            <Button
              label="Cancel"
              variant="secondary"
              onPress={() => {
                setPendingEmail(null);
                setEmailCode("");
              }}
            />
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              We&apos;ll send a confirmation code to the new address. Nothing changes until you
              enter it.
              {me.identities.length > 0
                ? " You sign in with a connected account — changing this here won't change it there."
                : ""}
            </Text>
            <TextInput
              style={styles.input}
              value={newEmail}
              onChangeText={setNewEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.textFaint}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
            />
            <Button
              label={sendEmailCode.isPending ? "Sending…" : "Send confirmation code"}
              disabled={sendEmailCode.isPending || newEmail.trim().length === 0}
              onPress={() => sendEmailCode.mutate()}
            />
          </>
        )}
      </Card>

      <SectionTitle>Password</SectionTitle>
      <Card>
        <Text style={styles.hint}>
          Opens a one-time link where you can set a new password — also how you add a password to an
          account that only signs in with Google or SSO.
        </Text>
        <Button
          label={changePassword.isPending ? "Opening…" : "Change password"}
          variant="secondary"
          disabled={changePassword.isPending}
          onPress={() => changePassword.mutate()}
        />
      </Card>

      <SectionTitle>Two-factor authentication</SectionTitle>
      <Card>
        {enrollment ? (
          <>
            <Text style={styles.hint}>
              Scan this code with your authenticator app, or copy the key below, then enter the
              six-digit code it shows.
            </Text>
            {enrollment.qrCode && <Image source={{ uri: enrollment.qrCode }} style={styles.qr} />}
            {enrollment.secret && (
              <Button
                label="Copy setup key"
                variant="secondary"
                onPress={() => {
                  void Clipboard.setStringAsync(enrollment.secret ?? "");
                }}
              />
            )}
            <TextInput
              style={[styles.input, { letterSpacing: 4 }]}
              value={code}
              onChangeText={(next) => setCode(next.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
            />
            <Button
              label={confirmEnrollment.isPending ? "Verifying…" : "Turn on two-factor"}
              disabled={confirmEnrollment.isPending || code.length !== 6}
              onPress={() => confirmEnrollment.mutate()}
            />
            <Button label="Cancel" variant="secondary" onPress={() => cancelEnrollment.mutate()} />
          </>
        ) : (
          <>
            {(factors.data ?? []).length === 0 ? (
              <Text style={styles.hint}>
                No authenticator apps yet. Add one for a second step when you sign in.
              </Text>
            ) : (
              <RowGroup>
                {(factors.data ?? []).map((factor) => (
                  <Row
                    key={factor.id}
                    title={factor.totpUser ?? "Authenticator app"}
                    subtitle={`${factor.type.toUpperCase()} · added ${new Date(
                      factor.createdAt,
                    ).toLocaleDateString()}`}
                    right={
                      <Button
                        label="Remove"
                        variant="secondary"
                        disabled={removeFactor.isPending}
                        onPress={() =>
                          Alert.alert("Remove authenticator", "Remove this second factor?", [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Remove",
                              style: "destructive",
                              onPress: () => removeFactor.mutate(factor.id),
                            },
                          ])
                        }
                      />
                    }
                  />
                ))}
              </RowGroup>
            )}
            <Button
              label={startEnrollment.isPending ? "Preparing…" : "Add authenticator app"}
              disabled={startEnrollment.isPending}
              onPress={() => startEnrollment.mutate()}
            />
          </>
        )}
      </Card>

      <SectionTitle>Active sessions</SectionTitle>
      <Card>
        {(sessions.data ?? []).length === 0 ? (
          <Text style={styles.hint}>No active sessions.</Text>
        ) : (
          <RowGroup>
            {(sessions.data ?? []).map((session) => (
              <Row
                key={session.id}
                title={`${describeUserAgent(session.userAgent)}${session.current ? " · this device" : ""}`}
                subtitle={`${session.ipAddress ?? "Unknown IP"} · ${formatAuthMethod(
                  session.authMethod,
                )} · ${new Date(session.createdAt).toLocaleDateString()}`}
                right={
                  session.current ? undefined : (
                    <Button
                      label="Sign out"
                      variant="secondary"
                      disabled={revokeOne.isPending}
                      onPress={() => revokeOne.mutate(session.id)}
                    />
                  )
                }
              />
            ))}
          </RowGroup>
        )}
        {otherSessions.length > 0 && (
          <Button
            label={revokeOthers.isPending ? "Signing out…" : "Sign out other sessions"}
            variant="danger"
            disabled={revokeOthers.isPending}
            onPress={() => revokeOthers.mutate()}
          />
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.surfaceOverlay },
  label: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  value: { color: colors.text, fontSize: 15 },
  hint: { color: colors.textMuted, fontSize: 12 },
  input: {
    backgroundColor: colors.surfaceOverlay,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 15,
  },
  qr: {
    width: 180,
    height: 180,
    alignSelf: "center",
    backgroundColor: "#fff",
    borderRadius: radii.sm,
  },
});
