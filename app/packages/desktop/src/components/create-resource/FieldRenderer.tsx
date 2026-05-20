import { useState, useEffect, useCallback } from "react";
import type { CreateFieldConfig, AssociationSource } from "@infrawrench/plugin-base";
import {
  FieldRenderer as SharedFieldRenderer,
  useUIStore,
  type SshKeyEntry,
  type SystemSshKey,
  type ResourcePickerOption,
  type ResourcePickerCallbacks,
  type FieldActionCallbacks,
} from "@infrawrench/ui";
import { invoke } from "../../lib/invoke";

export function FieldRenderer({
  field,
  value,
  onChange,
  resourcePickerProps,
  fieldActionProps,
  formValues,
}: {
  field: CreateFieldConfig;
  value: string;
  onChange: (v: string) => void;
  resourcePickerProps?: ResourcePickerCallbacks;
  fieldActionProps?: FieldActionCallbacks;
  formValues?: Record<string, string>;
}) {
  const [systemKeys, setSystemKeys] = useState<SystemSshKey[]>([]);
  const [cloudAuthed, setCloudAuthed] = useState(false);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  useEffect(() => {
    if (field.kind !== "ssh-key-picker") return;
    let cancelled = false;

    // Check cloud auth status
    invoke<string | null>("cloud_auth_get_token")
      .then((token) => {
        if (!cancelled) setCloudAuthed(!!token);
      })
      .catch(() => {
        if (!cancelled) setCloudAuthed(false);
      });

    async function loadSystemKeys() {
      try {
        const sysKeys = await invoke<{ name: string }[]>("ssh_list_system_keys");
        const entries: SystemSshKey[] = [];
        await Promise.all(
          sysKeys.map(async ({ name }) => {
            try {
              const pub = await invoke<string>("ssh_read_system_key", { name: `${name}.pub` });
              if (!cancelled && pub.trim()) {
                entries.push({ name, publicKey: pub.trim() });
              }
            } catch {
              /* no .pub file for this key */
            }
          }),
        );
        if (!cancelled) setSystemKeys(entries.sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        /* ssh scanning not available */
      }
    }
    void loadSystemKeys();
    return () => {
      cancelled = true;
    };
  }, [field.kind]);

  const loadKeys = useCallback(async (): Promise<SshKeyEntry[]> => {
    if (!cloudAuthed || !activeCloudOrgId) return [];
    try {
      return await invoke<SshKeyEntry[]>("cloud_ssh_keys_list", { orgId: activeCloudOrgId });
    } catch {
      return [];
    }
  }, [cloudAuthed, activeCloudOrgId]);

  const generateKey = useCallback(
    async (name: string): Promise<SshKeyEntry & { privateKey?: string }> => {
      if (!activeCloudOrgId) throw new Error("No active cloud workspace");
      return invoke<SshKeyEntry & { privateKey?: string }>("cloud_ssh_keys_create", {
        orgId: activeCloudOrgId,
        name,
      });
    },
    [activeCloudOrgId],
  );

  const deleteKey = useCallback(
    async (id: string): Promise<void> => {
      if (!activeCloudOrgId) throw new Error("No active cloud workspace");
      await invoke<void>("cloud_ssh_keys_delete", { orgId: activeCloudOrgId, id });
    },
    [activeCloudOrgId],
  );

  return (
    <SharedFieldRenderer
      field={field}
      value={value}
      onChange={onChange}
      sshKeyProps={{
        loadKeys,
        generateKey,
        deleteKey,
        systemKeys,
        cloudEnabled: cloudAuthed && activeCloudOrgId !== null,
        showCloudSection: activeCloudOrgId !== null,
        onCloudSignIn: () => {
          void invoke("cloud_auth_start").then(() => {
            // Poll until authenticated, then flip the flag
            const poll = setInterval(async () => {
              try {
                const token = await invoke<string | null>("cloud_auth_get_token");
                if (token) {
                  clearInterval(poll);
                  setCloudAuthed(true);
                }
              } catch {
                /* keep polling */
              }
            }, 1500);
            // Stop polling after 2 minutes
            setTimeout(() => clearInterval(poll), 120_000);
          });
        },
      }}
      {...(resourcePickerProps ? { resourcePickerProps } : {})}
      {...(fieldActionProps ? { fieldActionProps } : {})}
      {...(formValues ? { formValues } : {})}
    />
  );
}
