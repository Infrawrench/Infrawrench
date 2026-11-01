"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { useEffect, useState } from "react";
import type { AlertSummary } from "@/lib/alerts";
import { localePath } from "@/lib/i18n/locales";
import { BellIcon, CheckIcon } from "../icons";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; alert: AlertSummary }
  | { kind: "stopped" }
  | { kind: "error" };

/** Confirm or stop an email alert, from the link in its email. */
export function AlertManager({ id }: { id: string }) {
  const gt = useGT();
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/alerts/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 404) setState({ kind: "missing" });
        else if (!res.ok) setState({ kind: "error" });
        else setState({ kind: "ready", alert: (await res.json()) as AlertSummary });
      })
      .catch(() => live && setState({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [id]);

  const act = async (action: "confirm" | "unsubscribe") => {
    if (state.kind !== "ready") return;
    setWorking(true);
    try {
      const res = await fetch(`/api/alerts/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(
        action === "confirm"
          ? { kind: "ready", alert: { ...state.alert, confirmed: true } }
          : { kind: "stopped" },
      );
    } catch {
      setState({ kind: "error" });
    } finally {
      setWorking(false);
    }
  };

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-xl px-4 py-16 sm:px-7">
      <div className="rounded-xl border border-line p-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BellIcon className="h-5 w-5 text-ink-3" />
          {gt("Email alert")}
        </h1>
        {state.kind === "loading" && <p className="mt-4 text-ink-3">{gt("Loading…")}</p>}
        {state.kind === "missing" && (
          <p className="mt-4 text-ink-2">
            {gt("This alert does not exist any more. Unconfirmed alerts expire after three days.")}
          </p>
        )}
        {state.kind === "error" && (
          <p className="mt-4 text-ink-2">{gt("Something went wrong. Try again in a moment.")}</p>
        )}
        {state.kind === "stopped" && (
          <p className="mt-4 text-ink-2">
            {gt("Done. You will not get any more emails for this alert.")}
          </p>
        )}
        {state.kind === "ready" && (
          <>
            <p className="mt-4 text-ink-2">
              {state.alert.confirmed
                ? gt("{email} gets an email when this changes:", { email: state.alert.email })
                : gt("Confirm that {email} should get an email when this changes:", {
                    email: state.alert.email,
                  })}
            </p>
            <p className="mt-2 font-semibold">
              <Link
                className="text-accent hover:underline"
                href={localePath(locale, `/v/${state.alert.viewId}`)}
              >
                {state.alert.title || gt("Shared view")}
              </Link>
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {state.alert.confirmed ? (
                <span className="flex items-center gap-1.5 text-sm text-ink-2">
                  <CheckIcon className="h-4 w-4 text-[var(--series-3)]" />
                  {gt("Confirmed")}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void act("confirm")}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  {gt("Confirm alert")}
                </button>
              )}
              <button
                type="button"
                disabled={working}
                onClick={() => void act("unsubscribe")}
                className="rounded-md border border-line px-4 py-2 text-sm text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-60"
              >
                {state.alert.confirmed ? gt("Stop these emails") : gt("Cancel")}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
