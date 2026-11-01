/**
 * Conversations kept in the browser, so `/chat/<id>` survives a reload, the
 * back button and a trip to an instance page. Nothing about a conversation
 * is stored on the server (see the privacy page); a `/chat/<id>` link opened
 * elsewhere finds nothing and says so.
 */

const PREFIX = "instances-chat:";
/** Conversations kept; the oldest go first. */
const KEEP = 20;

export function newConversationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => (b % 36).toString(36)).join("");
}

export function loadConversation<T>(id: string): T[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    return raw ? ((JSON.parse(raw) as { messages: T[] }).messages ?? null) : null;
  } catch {
    // Private mode, blocked storage or an old shape: nothing to restore.
    return null;
  }
}

export function saveConversation<T>(id: string, messages: T[]): void {
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify({ at: Date.now(), messages }));
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
    if (keys.length <= KEEP) return;
    const byAge = keys
      .map((k) => {
        try {
          return {
            k,
            at: (JSON.parse(localStorage.getItem(k) ?? "{}") as { at?: number }).at ?? 0,
          };
        } catch {
          return { k, at: 0 };
        }
      })
      .sort((a, b) => a.at - b.at);
    for (const { k } of byAge.slice(0, byAge.length - KEEP)) localStorage.removeItem(k);
  } catch {
    // Quota or private mode; the conversation just will not survive a reload.
  }
}
