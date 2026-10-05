import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  ALERT_EMAIL_LIMITS,
  getAlertEmailOptions,
  isAlertEmailAddressAllowed,
  normalizeAlertEmailAddress,
  type AlertEmailRecipients,
} from "@infrawrench/client-core";
import { BareInput, Chip, ChipRow, Field, FormHint } from "@/components/form";
import { Button } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors } from "@/lib/theme";

/**
 * Native counterpart of web's `AlertEmailRecipientsField`: who a budget emails
 * when a threshold fires, beside the org's routing rules.
 *
 * Members are chips you tap to toggle (a phone has no comfortable select), and
 * extra addresses are typed and checked against the org's external-address
 * policy before the sheet saves, with the same client-core functions the
 * server runs.
 */
export function EmailRecipientsField({
  value,
  onChange,
}: {
  value: AlertEmailRecipients;
  onChange: (next: AlertEmailRecipients) => void;
}) {
  const { api, orgId } = useOrgApi();
  const options = useQuery({
    queryKey: ["alert-email-options", orgId],
    queryFn: () => getAlertEmailOptions(api, orgId),
  });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (options.isLoading) {
    return (
      <Field label="Email recipients">
        <FormHint>Loading members…</FormHint>
      </Field>
    );
  }
  if (!options.data) {
    // Without the member list the picker could only offer typed addresses the
    // server may reject; the stored list round-trips untouched either way.
    return null;
  }
  const opts = options.data;
  const known = new Set(opts.members.map((m) => m.userId));
  const formerCount = value.userIds.filter((id) => !known.has(id)).length;

  function toggleMember(userId: string) {
    onChange(
      value.userIds.includes(userId)
        ? { ...value, userIds: value.userIds.filter((id) => id !== userId) }
        : { ...value, userIds: [...value.userIds, userId] },
    );
  }

  function addAddress() {
    const address = normalizeAlertEmailAddress(draft);
    if (!address) {
      setError("That doesn't look like an email address.");
      return;
    }
    if (!isAlertEmailAddressAllowed(address, opts.settings, opts.memberDomains)) {
      setError(
        "This organization only allows alert email to its own domains. An admin can allow another domain from web or desktop settings.",
      );
      return;
    }
    const member = opts.members.find((m) => m.email === address);
    if (member) {
      if (!value.userIds.includes(member.userId)) {
        onChange({ ...value, userIds: [...value.userIds, member.userId] });
      }
    } else if (!value.addresses.includes(address)) {
      onChange({ ...value, addresses: [...value.addresses, address] });
    }
    setDraft("");
    setError(null);
  }

  return (
    <Field label="Email recipients">
      <FormHint>
        Emailed each time a threshold fires, in addition to your alert routing rules.
      </FormHint>
      {!opts.emailAvailable ? (
        <Text style={styles.warning}>
          Email isn&apos;t configured on this deployment, so recipients are saved but nothing is
          sent yet.
        </Text>
      ) : null}
      <ChipRow>
        {opts.members.map((m) => (
          <Chip
            key={m.userId}
            label={m.name || m.email}
            selected={value.userIds.includes(m.userId)}
            onPress={() => toggleMember(m.userId)}
          />
        ))}
      </ChipRow>
      {formerCount > 0 ? (
        <View style={styles.row}>
          <Text style={styles.warning}>
            {formerCount === 1 ? "1 former member" : `${formerCount} former members`} (no longer
            emailed)
          </Text>
          <Button
            label="Remove"
            variant="secondary"
            onPress={() =>
              onChange({ ...value, userIds: value.userIds.filter((id) => known.has(id)) })
            }
          />
        </View>
      ) : null}
      {value.addresses.length > 0 ? (
        <ChipRow>
          {value.addresses.map((address) => (
            <Chip
              key={address}
              label={`${address} ×`}
              selected
              onPress={() =>
                onChange({ ...value, addresses: value.addresses.filter((a) => a !== address) })
              }
            />
          ))}
        </ChipRow>
      ) : null}
      {value.addresses.length < ALERT_EMAIL_LIMITS.maxAddresses ? (
        <View style={styles.row}>
          <BareInput
            accessibilityLabel="Add an email address"
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              setError(null);
            }}
            placeholder="Another address"
            keyboardType="email-address"
          />
          <Button label="Add" variant="secondary" onPress={addAddress} />
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Field>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  warning: { color: colors.warning, fontSize: 12, marginTop: 4 },
  error: { color: colors.danger, fontSize: 12, marginTop: 4 },
});
