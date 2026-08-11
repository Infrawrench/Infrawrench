import { useState, useEffect, useCallback } from "react";
import { ConfirmDeleteModal } from "../components/ConfirmDeleteModal.js";
import { Modal } from "../components/Modal.js";
import {
  describeUserAgent,
  formatAuthMethod,
  formatProvider,
  type AccountDeletionPreview,
  type AuthFactor,
  type PendingEmailChange,
  type Profile,
  type UserSession,
} from "@infrawrench/client-core";
import { useSettingsHost, type SettingsApi } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

export function GeneralSection() {
  const { orgId, api } = useSettingsHost();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api.get<Profile>("/api/profile"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your profile");
    }
  }, [api]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!profile) return <div className="text-on-surface-muted text-sm animate-pulse">Loading…</div>;

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">General</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        Your personal account. These settings follow you across every organization you belong to.
      </p>

      <div className="space-y-4">
        <ProfileCard profile={profile} onSaved={loadProfile} />
        <PasswordCard />
        <TwoFactorCard />
        <SessionsCard />
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">Organization</h2>
          <span className={LABEL}>Organization ID</span>
          <p className="text-sm text-on-surface-secondary font-mono">{orgId}</p>
        </div>
        <DeleteAccountCard email={profile.email} />
      </div>
    </div>
  );
}

function ProfileCard({ profile, onSaved }: { profile: Profile; onSaved: () => Promise<void> }) {
  const { api } = useSettingsHost();
  const [firstName, setFirstName] = useState(profile.firstName ?? "");
  const [lastName, setLastName] = useState(profile.lastName ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingEmail, setChangingEmail] = useState(false);

  const dirty = firstName !== (profile.firstName ?? "") || lastName !== (profile.lastName ?? "");

  async function handleSave() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await api.patch("/api/profile", { firstName, lastName });
      await onSaved();
      setStatus("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleResendVerification() {
    setError(null);
    setStatus(null);
    try {
      await api.post("/api/profile/send-verification-email");
      setStatus("Verification email sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send verification email");
    }
  }

  return (
    <div className={CARD}>
      <h2 className="text-sm font-semibold text-on-surface-secondary mb-4">Profile</h2>

      <div className="flex items-start gap-4">
        {profile.profilePictureUrl ? (
          <img
            src={profile.profilePictureUrl}
            alt=""
            className="w-14 h-14 rounded-full border border-border flex-shrink-0"
          />
        ) : null}

        <div className="flex-1 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="profile-first-name" className={LABEL}>
                First name
              </label>
              <input
                id="profile-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={INPUT}
              />
            </div>
            <div>
              <label htmlFor="profile-last-name" className={LABEL}>
                Last name
              </label>
              <input
                id="profile-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={INPUT}
              />
            </div>
          </div>

          <div>
            <span className={LABEL}>Email</span>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm text-on-surface-secondary">{profile.email}</p>
              {profile.emailVerified ? (
                <span className="text-xs text-success">Verified</span>
              ) : (
                <>
                  <span className="text-xs text-warning">Unverified</span>
                  <button
                    type="button"
                    onClick={() => void handleResendVerification()}
                    className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary underline"
                  >
                    Resend verification email
                  </button>
                </>
              )}
            </div>
            <p className="text-xs text-on-surface-muted mt-1">
              {profile.identities.length > 0
                ? `Comes from ${profile.identities.map((i) => formatProvider(i.provider)).join(" / ")}, where you sign in.`
                : "The address you sign in with."}{" "}
              <button
                type="button"
                onClick={() => setChangingEmail(true)}
                className="text-on-surface-tertiary hover:text-on-surface-secondary underline"
              >
                Change email
              </button>
            </p>
          </div>

          {profile.identities.length > 0 && (
            <div>
              <span className={LABEL}>Connected accounts</span>
              <p className="text-sm text-on-surface-secondary">
                {profile.identities.map((i) => formatProvider(i.provider)).join(", ")}
              </p>
            </div>
          )}

          <div className="flex gap-6 text-xs text-on-surface-muted">
            <span>Member since {new Date(profile.createdAt).toLocaleDateString()}</span>
            {profile.lastSignInAt && (
              <span>Last sign-in {new Date(profile.lastSignInAt).toLocaleString()}</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              className={PRIMARY_BUTTON}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            {status && <span className="text-xs text-success">{status}</span>}
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        </div>
      </div>

      {changingEmail && (
        <ChangeEmailModal
          api={api}
          currentEmail={profile.email}
          hasIdentities={profile.identities.length > 0}
          onClose={() => setChangingEmail(false)}
          onChanged={async () => {
            setChangingEmail(false);
            await onSaved();
          }}
        />
      )}
    </div>
  );
}

/**
 * Two steps, because WorkOS only moves the account once a code delivered to the
 * new address comes back. Until then the current address keeps working, so
 * abandoning this dialog costs nothing.
 */
function ChangeEmailModal({
  api,
  currentEmail,
  hasIdentities,
  onClose,
  onChanged,
}: {
  api: SettingsApi;
  currentEmail: string;
  hasIdentities: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [pending, setPending] = useState<PendingEmailChange | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    setBusy(true);
    setError(null);
    try {
      setPending(
        await api.post<PendingEmailChange>("/api/profile/email-change", {
          newEmail: newEmail.trim(),
        }),
      );
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the confirmation code");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/profile/email-change/confirm", { code: code.trim() });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That code isn't valid");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Change email address">
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Change email address</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg"
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          {!pending ? (
            <>
              <p className="text-xs text-on-surface-muted">
                We&apos;ll send a confirmation code to the new address. Your account stays on{" "}
                <span className="text-on-surface-secondary">{currentEmail}</span> until you enter
                it.
              </p>
              {hasIdentities && (
                <p className="text-xs text-warning">
                  You sign in with a connected account. Changing this address here won&apos;t change
                  it there, so make sure you can still sign in afterwards.
                </p>
              )}
              <div>
                <label htmlFor="new-email" className={LABEL}>
                  New email address
                </label>
                <input
                  id="new-email"
                  type="email"
                  autoComplete="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={INPUT}
                />
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={busy || !newEmail.trim()}
                className={`${PRIMARY_BUTTON} w-full`}
              >
                {busy ? "Sending…" : "Send confirmation code"}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-on-surface-muted">
                Enter the code we sent to{" "}
                <span className="text-on-surface-secondary">{pending.newEmail}</span>. It expires{" "}
                {new Date(pending.expiresAt).toLocaleTimeString()}.
              </p>
              <div>
                <label htmlFor="email-change-code" className={LABEL}>
                  Confirmation code
                </label>
                <input
                  id="email-change-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
                  placeholder="123456"
                  className={`${INPUT} font-mono tracking-widest`}
                />
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={busy || !code.trim()}
                className={`${PRIMARY_BUTTON} w-full`}
              >
                {busy ? "Confirming…" : "Confirm new email"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPending(null);
                  setError(null);
                }}
                className="w-full text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
              >
                Use a different address
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PasswordCard() {
  const { api, openExternal } = useSettingsHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    setBusy(true);
    setError(null);
    try {
      const { passwordResetUrl } = await api.post<{ passwordResetUrl: string }>(
        "/api/profile/password-reset",
      );
      openExternal(passwordResetUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create a reset link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-on-surface-secondary mb-1">Password</h2>
          <p className="text-xs text-on-surface-muted max-w-md">
            Opens a one-time link where you can set a new password. Use it to add a password to an
            account that only signs in with Google or SSO.
          </p>
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
        </div>
        <button
          type="button"
          onClick={() => void handleReset()}
          disabled={busy}
          className={`${SECONDARY_BUTTON} flex-shrink-0`}
        >
          {busy ? "Opening…" : "Change password"}
        </button>
      </div>
    </div>
  );
}

function TwoFactorCard() {
  const { api } = useSettingsHost();
  const [factors, setFactors] = useState<AuthFactor[] | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFactors(await api.get<AuthFactor[]>("/api/profile/mfa"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load two-factor settings");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRemove(factorId: string) {
    setError(null);
    try {
      await api.delete(`/api/profile/mfa/${encodeURIComponent(factorId)}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface-secondary mb-1">
            Two-factor authentication
          </h2>
          <p className="text-xs text-on-surface-muted max-w-md">
            Add a time-based one-time code from an authenticator app as a second step when you sign
            in.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnrolling(true)}
          className={`${PRIMARY_BUTTON} flex-shrink-0`}
        >
          Add authenticator app
        </button>
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      {factors === null ? (
        <p className="text-xs text-on-surface-faint">Loading…</p>
      ) : factors.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No authenticator apps yet. Your account is protected by your sign-in method alone.
        </p>
      ) : (
        <ul className="divide-y divide-border/50 border border-border rounded-lg">
          {factors.map((factor) => (
            <li key={factor.id} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-sm text-on-surface-secondary">
                  {factor.totpUser ?? "Authenticator app"}
                </p>
                <p className="text-xs text-on-surface-muted">
                  {factor.type.toUpperCase()} · added{" "}
                  {new Date(factor.createdAt).toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(factor.id)}
                className="text-xs text-danger hover:text-danger-strong"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {enrolling && (
        <EnrollTotpModal
          api={api}
          onClose={() => {
            setEnrolling(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

interface Enrollment {
  factorId: string;
  challengeId: string;
  qrCode: string | null;
  secret: string | null;
  uri: string | null;
}

/**
 * WorkOS creates the factor as soon as enrolment starts, so closing without
 * verifying has to delete it again — otherwise a half-finished setup would sit
 * in the list indistinguishable from a working one.
 */
function EnrollTotpModal({ api, onClose }: { api: SettingsApi; onClose: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.post<Enrollment>("/api/profile/mfa");
        if (cancelled) {
          await api
            .delete(`/api/profile/mfa/${encodeURIComponent(result.factorId)}`)
            .catch(() => {});
          return;
        }
        setEnrollment(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to start enrolment");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  function handleCancel() {
    if (enrollment && !done) {
      void api
        .delete(`/api/profile/mfa/${encodeURIComponent(enrollment.factorId)}`)
        .catch(() => {});
    }
    onClose();
  }

  async function handleVerify() {
    if (!enrollment) return;
    setVerifying(true);
    setError(null);
    try {
      await api.post(`/api/profile/mfa/${encodeURIComponent(enrollment.factorId)}/verify`, {
        challengeId: enrollment.challengeId,
        code,
      });
      setDone(true);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
      // The challenge is spent either way — get a fresh one so the next
      // attempt isn't rejected for the wrong reason.
      try {
        const next = await api.post<{ challengeId: string }>(
          `/api/profile/mfa/${encodeURIComponent(enrollment.factorId)}/challenge`,
        );
        setEnrollment({ ...enrollment, challengeId: next.challengeId });
      } catch {
        /* keep the original challenge and let the user retry */
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Modal onClose={handleCancel} ariaLabel="Add authenticator app">
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Add authenticator app</h2>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Close"
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg"
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4">
          {!enrollment ? (
            <p className="text-sm text-on-surface-muted">
              {error ?? "Preparing your authenticator setup…"}
            </p>
          ) : (
            <>
              <p className="text-xs text-on-surface-muted">
                Scan this code with your authenticator app, then enter the six-digit code it shows.
              </p>
              {enrollment.qrCode && (
                <img
                  src={enrollment.qrCode}
                  alt="Two-factor enrolment QR code"
                  className="w-40 h-40 mx-auto bg-white rounded-lg p-2"
                />
              )}
              {enrollment.secret && (
                <div>
                  <span className={LABEL}>Or enter this key manually</span>
                  <div className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs text-on-surface-secondary break-all select-all">
                    {enrollment.secret}
                  </div>
                </div>
              )}
              <div>
                <label htmlFor="totp-code" className={LABEL}>
                  Six-digit code
                </label>
                <input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className={`${INPUT} font-mono tracking-widest`}
                />
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
              <button
                type="button"
                onClick={() => void handleVerify()}
                disabled={verifying || code.length !== 6}
                className={`${PRIMARY_BUTTON} w-full`}
              >
                {verifying ? "Verifying…" : "Turn on two-factor"}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SessionsCard() {
  const { api } = useSettingsHost();
  const [sessions, setSessions] = useState<UserSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api.get<UserSession[]>("/api/profile/sessions"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevoke(sessionId: string) {
    setError(null);
    try {
      await api.delete(`/api/profile/sessions/${encodeURIComponent(sessionId)}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke");
    }
  }

  async function handleRevokeOthers() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/profile/sessions/revoke-others");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke");
    } finally {
      setBusy(false);
    }
  }

  const others = (sessions ?? []).filter((s) => !s.current);

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface-secondary mb-1">Active sessions</h2>
          <p className="text-xs text-on-surface-muted max-w-md">
            Everywhere you&apos;re currently signed in — the web app, the desktop app, the CLI and
            mobile.
          </p>
        </div>
        {others.length > 0 && (
          <button
            type="button"
            onClick={() => void handleRevokeOthers()}
            disabled={busy}
            className={`${SECONDARY_BUTTON} flex-shrink-0`}
          >
            {busy ? "Signing out…" : "Sign out other sessions"}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      {sessions === null ? (
        <p className="text-xs text-on-surface-faint">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-on-surface-muted">No active sessions.</p>
      ) : (
        <ul className="divide-y divide-border/50 border border-border rounded-lg">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between px-3 py-2 gap-3">
              <div className="min-w-0">
                <p className="text-sm text-on-surface-secondary truncate">
                  {describeUserAgent(session.userAgent)}
                  {session.current && (
                    <span className="ml-2 text-xs text-success">This device</span>
                  )}
                </p>
                <p className="text-xs text-on-surface-muted truncate">
                  {session.ipAddress ?? "Unknown IP"} · {formatAuthMethod(session.authMethod)} ·
                  started {new Date(session.createdAt).toLocaleString()}
                </p>
              </div>
              {!session.current && (
                <button
                  type="button"
                  onClick={() => void handleRevoke(session.id)}
                  className="text-xs text-danger hover:text-danger-strong flex-shrink-0"
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Deleting the account. Required by App Store guideline 5.1.1(v) — an app that
 * can create an account has to be able to delete one — but it is the same
 * account everywhere, so it lives here rather than only on mobile.
 *
 * The preview is fetched up front rather than letting the user discover the
 * consequences from a rejection: it names the organizations that go with the
 * account, and the ones that have to be handed over first. The server refuses
 * the same cases again on DELETE, so a stale preview is safe.
 */
function DeleteAccountCard({ email }: { email: string }) {
  const { api, onAccountDeleted } = useSettingsHost();
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api
      .get<AccountDeletionPreview>("/api/profile/deletion-preview")
      .then(setPreview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [api]);

  async function handleDelete() {
    await api.delete("/api/profile");
    // Every session was revoked server-side; the host drops its local session
    // state and leaves (web: back to sign-in, desktop: out of cloud mode).
    onAccountDeleted();
  }

  const blocked = (preview?.blockers.length ?? 0) > 0;

  return (
    <div className="border border-red-500/30 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-on-surface-secondary mb-1">Delete account</h2>
      <p className="text-xs text-on-surface-tertiary mb-3">
        Permanently deletes your account, your SSH and API keys, your chat history, and your
        membership of every organization. This cannot be undone.
      </p>

      {error && <p className="text-xs text-danger mb-3">{error}</p>}

      {preview && blocked && (
        <div className="mb-3 rounded-lg border border-border bg-surface-overlay p-3">
          <p className="text-xs text-on-surface-secondary mb-2">
            You are the only owner of{" "}
            {preview.blockers.length === 1 ? "an organization" : "these organizations"} that other
            people belong to. Promote another owner in <strong>Settings → Team</strong>, then come
            back.
          </p>
          <ul className="text-xs text-on-surface-tertiary space-y-1">
            {preview.blockers.map((b) => (
              <li key={b.id}>
                <span className="text-on-surface-secondary">{b.name}</span> — {b.memberCount}{" "}
                members
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && !blocked && preview.organizationsToDelete.length > 0 && (
        <div className="mb-3 rounded-lg border border-border bg-surface-overlay p-3">
          <p className="text-xs text-on-surface-secondary mb-2">
            You are the only member of{" "}
            {preview.organizationsToDelete.length === 1
              ? "this organization, so it"
              : "these organizations, so they"}{" "}
            will be deleted too, along with everything in{" "}
            {preview.organizationsToDelete.length === 1 ? "it" : "them"}. Any active subscription is
            cancelled.
          </p>
          <ul className="text-xs text-on-surface-tertiary space-y-1">
            {preview.organizationsToDelete.map((o) => (
              <li key={o.id}>{o.name}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={!preview || blocked}
        className="px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600 text-white rounded-lg transition-colors"
      >
        Delete account
      </button>

      {confirming && (
        <ConfirmDeleteModal
          kind="account"
          name={email}
          onConfirm={handleDelete}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
