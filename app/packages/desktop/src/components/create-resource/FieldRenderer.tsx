import { useState, useEffect, useCallback } from "react";
import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import {
  FieldRenderer as SharedFieldRenderer,
  useUIStore,
  type SshKeyEntry,
  type SystemSshKey,
  type AgentSshKey,
  type ResourcePickerCallbacks,
  type FieldActionCallbacks,
} from "@infrawrench/ui";
import { getCloudAuthStatus, startCloudAuth } from "../../lib/cloud-auth";
import { createCloudSshKey, deleteCloudSshKey, listCloudSshKeys } from "../../lib/cloud-ssh-keys";
import { list1PasswordKeys, listSystemKeys, readSystemKey } from "../../lib/ssh-keys";

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
  const [onePasswordKeys, setOnePasswordKeys] = useState<AgentSshKey[]>([]);
  const [cloudAuthed, setCloudAuthed] = useState(false);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  useEffect(() => {
    if (field.kind !== "ssh-key-picker") return;
    let cancelled = false;

    getCloudAuthStatus()
      .then((status) => {
        if (!cancelled) setCloudAuthed(status.authenticated);
      })
      .catch(() => {
        if (!cancelled) setCloudAuthed(false);
      });

    async function loadSystemKeys() {
      try {
        const sysKeys = await listSystemKeys();
        const entries: SystemSshKey[] = [];
        await Promise.all(
          sysKeys.map(async ({ name }) => {
            try {
              const pub = await readSystemKey(`${name}.pub`);
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

    async function loadOnePasswordKeys() {
      try {
        const keys = await list1PasswordKeys();
        if (!cancelled) setOnePasswordKeys(keys);
      } catch {
        /* agent unavailable */
      }
    }
    void loadOnePasswordKeys();

    return () => {
      cancelled = true;
    };
  }, [field.kind]);

  const loadKeys = useCallback(async (): Promise<SshKeyEntry[]> => {
    if (!cloudAuthed || !activeCloudOrgId) return [];
    try {
      return await listCloudSshKeys(activeCloudOrgId);
    } catch {
      return [];
    }
  }, [cloudAuthed, activeCloudOrgId]);

  const generateKey = useCallback(
    async (name: string): Promise<SshKeyEntry & { privateKey?: string }> => {
      if (!activeCloudOrgId) throw new Error("No active cloud workspace");
      return createCloudSshKey(activeCloudOrgId, name);
    },
    [activeCloudOrgId],
  );

  const deleteKey = useCallback(
    async (id: string): Promise<void> => {
      if (!activeCloudOrgId) throw new Error("No active cloud workspace");
      await deleteCloudSshKey(activeCloudOrgId, id);
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
        onePasswordKeys,
        cloudEnabled: cloudAuthed && activeCloudOrgId !== null,
        showCloudSection: activeCloudOrgId !== null,
        onCloudSignIn: () => {
          void startCloudAuth().then(() => {
            // Sign-in happens in a separate browser tab, so there's no
            // callback to await: poll the token store until it lands.
            const poll = setInterval(async () => {
              try {
                const status = await getCloudAuthStatus();
                if (status.authenticated) {
                  clearInterval(poll);
                  setCloudAuthed(true);
                }
              } catch {
                /* keep polling */
              }
            }, 1500);
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
