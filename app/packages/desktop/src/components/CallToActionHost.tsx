import { useCallback, useEffect, useState } from "react";
import { useGT, useLocale } from "gt-react";
import { LazyChatMarkdown, Modal } from "@infrawrench/ui";
import { openExternalUrl } from "../lib/app-shell";
import {
  completeCallToAction,
  listPendingCallsToAction,
  type PendingCallToAction,
} from "../lib/calls-to-action";

/** A long-running window picks up new calls to action this often. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

interface CallToActionHostProps {
  /** False while something else owns the window (first-run onboarding, tab restore). */
  enabled: boolean;
  signedIn: boolean;
  /** A sign-in call to action was accepted: start the cloud sign-in flow. */
  onSignIn: () => void;
}

/** The first markdown heading, for the dialog's accessible name. */
function headingOf(markdown: string): string | null {
  const match = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return match?.[1] ?? null;
}

/**
 * Shows the pending calls to action from the website's feed one at a time,
 * over the whole window (`electron/calls-to-action.ts` decides which). Acting
 * on or dismissing one records it in the main process, so it never returns.
 */
export function CallToActionHost({ enabled, signedIn, onSignIn }: CallToActionHostProps) {
  const gt = useGT();
  const locale = useLocale();
  const [queue, setQueue] = useState<PendingCallToAction[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const check = () => {
      listPendingCallsToAction({ signedIn, locale })
        .then((pending) => {
          if (cancelled) return;
          // Keep the one on screen where it is; add what is new behind it.
          setQueue((current) => {
            const ids = new Set(current.map((c) => c.id));
            return [...current, ...pending.filter((p) => !ids.has(p.id))];
          });
        })
        .catch((e) => console.error("[calls-to-action] failed to load:", e));
    };
    check();
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, signedIn, locale]);

  // A sign-in call to action only applies while signed out; one queued before
  // the user signed in some other way is skipped (and offered again if they
  // sign out before dismissing it).
  const current = enabled
    ? queue.find((c) => !(c.action.type === "sign-in" && signedIn))
    : undefined;

  const finish = useCallback((id: string) => {
    setQueue((q) => q.filter((c) => c.id !== id));
    completeCallToAction(id).catch((e) =>
      console.error("[calls-to-action] failed to record completion:", e),
    );
  }, []);

  if (!current) return null;

  const id = current.id;
  const action = current.action;
  const actionLabel =
    current.actionLabel ??
    (action.type === "sign-in" ? gt("Sign in to Infrawrench Cloud") : gt("Learn more"));
  const dismissLabel = current.dismissLabel ?? gt("Not now");

  function act() {
    finish(id);
    if (action.type === "sign-in") onSignIn();
    else
      openExternalUrl(action.url).catch((e) =>
        console.error("[calls-to-action] failed to open link:", e),
      );
  }

  const primaryClass =
    "px-4 py-2.5 text-sm font-medium bg-accent hover:bg-accent-hover text-on-accent rounded-lg transition-colors";

  return (
    // No `onClose`: the call to action is left through its own buttons, so
    // a stray Escape or backdrop click is not read as "never show this again".
    <Modal
      key={current.id}
      ariaLabel={headingOf(current.markdown) ?? gt("Message from Infrawrench")}
      fullScreen
    >
      <div className="h-full w-full bg-surface flex flex-col">
        {/* Keep the window draggable while the overlay covers the title bar. */}
        <div
          className="h-8 flex-shrink-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
        <div className="flex-1 overflow-y-auto flex items-center justify-center px-6 py-8">
          <div className="w-full max-w-lg">
            <div className="[&_h1]:text-xl [&_h1]:text-on-surface [&_h1]:mb-2 [&_h2]:text-base [&_h2]:text-on-surface [&_p]:text-on-surface-tertiary [&_a]:underline [&_a]:underline-offset-2">
              <LazyChatMarkdown text={current.markdown} />
            </div>

            {current.layout === "side-by-side" ? (
              <div className="mt-7 flex gap-2">
                <button
                  type="button"
                  onClick={() => finish(id)}
                  className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-border-strong text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                >
                  {dismissLabel}
                </button>
                <button type="button" autoFocus onClick={act} className={`flex-1 ${primaryClass}`}>
                  {actionLabel}
                </button>
              </div>
            ) : (
              <div className="mt-7 flex flex-col gap-2">
                <button type="button" autoFocus onClick={act} className={`w-full ${primaryClass}`}>
                  {actionLabel}
                </button>
                <button
                  type="button"
                  onClick={() => finish(id)}
                  className="w-full px-4 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                >
                  {dismissLabel}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
