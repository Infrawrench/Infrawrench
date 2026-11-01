"use client";

import { useGT, useLocale } from "gt-react";
import { useState } from "react";
import { BellIcon, CheckIcon } from "../icons";

/** "Email me when this changes": starts a double opt-in subscription to a view. */
export function AlertForm({ viewId, onClose }: { viewId: string; onClose: () => void }) {
  const gt = useGT();
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("sending");
    try {
      const res = await fetch(`/api/views/${viewId}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, locale }),
      });
      if (res.ok) {
        setState("sent");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        res.status === 429
          ? gt("Too many sign-ups from here; try again in a minute.")
          : res.status === 400
            ? gt("That email address does not look right.")
            : gt("Could not start the alert. Try again later."),
      );
      console.warn("subscribe failed", body.error);
      setState("error");
    } catch {
      setError(gt("Could not start the alert. Try again later."));
      setState("error");
    }
  };

  if (state === "sent") {
    return (
      <div className="flex items-start gap-2 border-t border-line bg-surface-2 px-3 py-3 text-sm">
        <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--series-3)]" />
        <p>
          {gt(
            "Check your inbox: we sent a link to confirm. After that, you get an email whenever AWS's prices change what this shows.",
          )}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="border-t border-line bg-surface-2 px-3 py-3">
      <label htmlFor={`alert-${viewId}`} className="flex items-center gap-2 text-sm font-medium">
        <BellIcon className="h-4 w-4 text-ink-3" />
        {gt("Email me when this changes")}
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          id={`alert-${viewId}`}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          // i18n-ignore: example email address
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-base outline-none focus:border-accent sm:text-sm"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {state === "sending" ? gt("Sending…") : gt("Subscribe")}
        </button>
        <button type="button" onClick={onClose} className="px-2 text-sm text-ink-3 hover:text-ink">
          {gt("Cancel")}
        </button>
      </div>
      {state === "error" && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <p className="mt-2 text-xs text-ink-3">
        {gt(
          "We check after every AWS price list update. Each email has a link to stop them. Your address is used for nothing else.",
        )}
      </p>
    </form>
  );
}
