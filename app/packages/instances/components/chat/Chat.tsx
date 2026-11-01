"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { T, Var, useGT, useLocale } from "gt-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadConversation, newConversationId, saveConversation } from "@/lib/chat/storage";
import {
  viewRef,
  type ChatEvent,
  type ChatTurn,
  type ViewData,
  type ViewRef,
} from "@/lib/chat/types";
import { localePath } from "@/lib/i18n/locales";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  BarChartIcon,
  BellIcon,
  CpuIcon,
  ServerIcon,
  StopIcon,
  TableIcon,
} from "../icons";
import { Markdown } from "./Markdown";
import { ViewCard } from "./ViewCard";

/** One message as the page shows it. */
/**
 * A piece of a message, in the order it arrived: an answer that shows a
 * table and then comments on it reads, and lays out, in that order, so text
 * streaming in after a table goes below it instead of pushing it down.
 */
type Part =
  | { kind: "text"; text: string }
  /** `data` is missing while a restored conversation fetches it again. */
  | { kind: "view"; ref: ViewRef; data?: ViewData; watch?: boolean };

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  /** While the answer is streaming: what it is doing. */
  status?: { kind: "thinking" | "query"; sql?: string };
  error?: string;
  pending?: boolean;
}

/** Product names, so never translated. */
const SERVICES = [
  "Amazon EC2",
  "Amazon RDS",
  "ElastiCache",
  "OpenSearch",
  "SageMaker",
  "Redshift",
  "MemoryDB",
  "Amazon EMR",
  "GameLift",
  "DocumentDB",
  "Neptune",
];

let counter = 0;
const nextId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * The service in the headline, rolling every few seconds: the outgoing name
 * slides up and out while the next slides up into the same slot, and the
 * slot eases to the new name's width, so the "?" after it moves smoothly and
 * is never covered. Held still for reduced motion.
 */
function CyclingService() {
  // The name showing, and the one rolling out (null until the first change).
  const [{ i, previous }, setNames] = useState<{ i: number; previous: number | null }>({
    i: 0,
    previous: null,
  });
  const sizer = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(
      () => setNames(({ i: n }) => ({ i: (n + 1) % SERVICES.length, previous: n })),
      2600,
    );
    return () => clearInterval(timer);
  }, []);
  // The slot's width follows the current name (measured from an invisible
  // copy), and the transition on it does the easing.
  useLayoutEffect(() => {
    if (sizer.current) setWidth(sizer.current.offsetWidth);
  }, [i]);
  return (
    <span
      className="relative inline-block overflow-hidden pb-[0.15em] align-bottom -mb-[0.15em] whitespace-nowrap text-accent transition-[width] duration-[600ms] ease-in-out"
      style={width === null ? undefined : { width }}
    >
      {/* Sets the line's height (and its width before the first measure). */}
      <span ref={sizer} aria-hidden="true" className="invisible inline-block">
        {SERVICES[i]}
      </span>
      {previous !== null && (
        <span
          key={`out-${previous}`}
          aria-hidden="true"
          className="absolute top-0 left-0 animate-[service-out_0.6s_ease-in-out_forwards]"
        >
          {SERVICES[previous]}
        </span>
      )}
      <span
        key={`in-${i}`}
        className={`absolute top-0 left-0 ${previous !== null ? "animate-[service-in_0.6s_ease-in-out]" : ""}`}
      >
        {SERVICES[i]}
      </span>
    </span>
  );
}

function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  const gt = useGT();
  const items = [
    { icon: CpuIcon, text: gt("What is the cheapest ARM AWS instance?") },
    { icon: BellIcon, text: gt("Can you notify me if a new cheap ARM EC2 instance is available?") },
    { icon: TableIcon, text: gt("Build me a table of x86_64 EC2 instances") },
    { icon: BarChartIcon, text: gt("Show me a bar graph of ARM instance costs running Linux") },
  ];
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map(({ icon: Icon, text }) => (
        <li key={text}>
          <button
            type="button"
            onClick={() => onPick(text)}
            className="group flex h-full w-full items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left text-sm transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-md focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3 transition-colors group-hover:bg-accent group-hover:text-white">
              <Icon className="h-4 w-4" />
            </span>
            <span className="pt-1.5 text-ink-2 group-hover:text-ink">{text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Composer({
  onSend,
  onStop,
  busy,
  autoFocus,
  floating,
  placeholder,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  autoFocus?: boolean;
  floating?: boolean;
  /** In place of the default question prompt. */
  placeholder?: string;
}) {
  const gt = useGT();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className={`flex items-end gap-2 rounded-2xl border border-line p-2 shadow-sm transition-colors focus-within:border-accent ${floating ? "bg-surface/70 shadow-lg backdrop-blur-xl" : "bg-surface"}`}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        // The landing page is a search box; focusing it is the expected start.
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={placeholder ?? gt("Ask about prices, specs, regions or history…")}
        aria-label={gt("Your question")}
        maxLength={4000}
        className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none sm:text-[15px] placeholder:text-ink-3"
      />
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          aria-label={gt("Stop")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink text-surface hover:opacity-80"
        >
          <StopIcon className="h-4 w-4" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!text.trim()}
          aria-label={gt("Send")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-opacity hover:bg-accent-hover disabled:opacity-40"
        >
          <ArrowUpIcon className="h-4 w-4" />
        </button>
      )}
    </form>
  );
}

function Status({ status }: { status: NonNullable<UiMessage["status"]> }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm text-ink-3">
      <span className="inline-flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
        {status.kind === "query" ? gt("Querying the price lists…") : gt("Thinking…")}
        {status.sql && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs underline">
            {open ? gt("Hide query") : gt("Show query")}
          </button>
        )}
      </span>
      {open && status.sql && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap">
          {status.sql}
        </pre>
      )}
    </div>
  );
}

const textOf = (m: UiMessage) =>
  m.parts
    .flatMap((p) => (p.kind === "text" ? [p.text] : []))
    .join("\n\n")
    .trim();

/** A view whose data is on its way: same frame and title, so nothing moves when it lands. */
function ViewPlaceholder({ title }: { title: string }) {
  const gt = useGT();
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <header className="border-b border-line px-3 py-2.5 font-semibold">{title}</header>
      <div className="flex h-48 items-center justify-center text-sm text-ink-3">
        <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-accent" />
        {gt("Loading…")}
      </div>
    </section>
  );
}

function Message({ message }: { message: UiMessage }) {
  const gt = useGT();
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-surface-2 px-4 py-2.5 whitespace-pre-wrap text-ink">
          {textOf(message)}
        </p>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-4">
      {message.parts.map((p, i) =>
        p.kind === "text" ? (
          p.text.trim() ? (
            <Markdown key={i} text={p.text} />
          ) : null
        ) : p.data ? (
          <ViewCard key={p.ref.id} data={p.data} watch={p.watch ?? false} />
        ) : (
          <ViewPlaceholder key={p.ref.id} title={p.ref.title} />
        ),
      )}
      {message.pending && message.status && <Status status={message.status} />}
      {message.error && (
        <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm">
          {message.error === "rate_limited"
            ? gt("That is a lot of questions in a short time. Wait a minute and ask again.")
            : message.error === "refused"
              ? gt("I can't help with that one. Ask me about AWS instance types and their prices.")
              : gt("Something went wrong answering that. Try again in a moment.")}
        </p>
      )}
    </div>
  );
}

/**
 * A message as the browser keeps it: views without their data (a table can
 * be 2,000 rows), fetched again from `/api/views/<id>` when the conversation
 * is restored, which also brings them up to date.
 */
interface StoredMessage {
  id: string;
  role: UiMessage["role"];
  parts: Part[];
  error?: string;
}

const toStored = (m: UiMessage): StoredMessage => ({
  id: m.id,
  role: m.role,
  parts: m.parts.map((p) =>
    p.kind === "text" ? p : { kind: "view", ref: p.ref, ...(p.watch ? { watch: true } : {}) },
  ),
  ...(m.error ? { error: m.error } : {}),
});

async function loadView(id: string): Promise<ViewData | null> {
  try {
    const res = await fetch(`/api/views/${encodeURIComponent(id)}`);
    return res.ok ? ((await res.json()) as ViewData) : null;
  } catch {
    return null;
  }
}

const toTurns = (messages: UiMessage[]): ChatTurn[] =>
  messages
    .filter((m) => !m.pending && m.parts.length)
    .map((m) => {
      const views = m.parts.flatMap((p) => (p.kind === "view" ? [p.ref] : []));
      return { role: m.role, text: textOf(m), ...(views.length ? { views } : {}) };
    });

/** The home page: the headline, the question box and suggestions. Asking opens `/chat/<id>`. */
export function ChatHome() {
  const gt = useGT();
  const locale = useLocale();
  const router = useRouter();
  const start = useCallback(
    (text: string, replace = false) => {
      const href = `${localePath(locale, `/chat/${newConversationId()}`)}?q=${encodeURIComponent(text.slice(0, 4000))}`;
      if (replace) router.replace(href);
      else router.push(href);
    },
    [locale, router],
  );

  // `/?q=...` still asks straight away, so questions can be linked.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) start(q, true);
  }, [start]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-[calc(100vh-110px)] max-w-3xl flex-col justify-center px-4 py-12 sm:px-7"
    >
      <h1 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
        {/* The name sits on its own centered line, so changing it moves nothing else. */}
        <T>
          What do you want to know about
          <br />
          <Var>
            <CyclingService />
          </Var>
          ?
        </T>
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-ink-2">
        {gt(
          "Ask in plain language. Answers come from AWS's own price lists for every region, with history, as tables and charts you can share.",
        )}
      </p>
      <div className="mt-8">
        <Composer onSend={(text) => start(text)} onStop={() => {}} busy={false} autoFocus />
      </div>
      <div className="mt-6">
        <Suggestions onPick={(text) => start(text)} />
      </div>
      <div className="mt-10 flex justify-center">
        <Link
          href={localePath(locale, "/aws")}
          className="group inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm text-ink-2 transition-colors hover:border-accent hover:text-ink"
        >
          <ServerIcon className="h-4 w-4 text-ink-3 group-hover:text-accent" />
          {gt("Browse AWS instances")}
          <ArrowRightIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </main>
  );
}

/**
 * `/v/<id>`: a shared table or chart filling the window, with a question box
 * under it. Asking opens a new conversation (`/chat/<id>`) that starts with
 * this view, so the answer can build on it.
 */
export function SharedView({ data }: { data: ViewData }) {
  const gt = useGT();
  const locale = useLocale();
  const router = useRouter();
  const ask = (text: string) => {
    const id = newConversationId();
    const first: StoredMessage = {
      id: nextId(),
      role: "assistant",
      parts: [{ kind: "view", ref: viewRef(data.view) }],
    };
    saveConversation(id, [first]);
    router.push(
      `${localePath(locale, `/chat/${id}`)}?q=${encodeURIComponent(text.slice(0, 4000))}`,
    );
  };
  return (
    // Fills what the nav and footer leave of the window (`data-fit-window`,
    // see globals.css): the table or chart scrolls inside the card, and the
    // page itself does not scroll at all.
    <main
      id="main-content"
      tabIndex={-1}
      data-fit-window=""
      className="flex min-h-0 flex-1 flex-col gap-3 px-3 pt-3 pb-3 sm:px-5"
    >
      <ViewCard data={data} fill />
      <div className="mx-auto mt-auto w-full max-w-3xl shrink-0">
        <Composer
          onSend={ask}
          onStop={() => {}}
          busy={false}
          placeholder={
            data.view.kind === "table" ? gt("Ask about this table") : gt("Ask about this chart")
          }
        />
        <p className="mt-1.5 flex justify-between gap-3 px-1 text-[11px] text-ink-3">
          <span>{gt("Answers come from AWS's public price lists; check before you commit.")}</span>
          <Link href={localePath(locale, "/")} className="shrink-0 hover:text-ink">
            {gt("New conversation")}
          </Link>
        </p>
      </div>
    </main>
  );
}

/**
 * A conversation. `/chat/<id>` keeps it in this browser under its id, and
 * asks its `?q=` on arrival: that is how the home page hands over the first
 * question, and how a shared view (saved here first) hands over a follow-up.
 */
export function Chat({ conversationId }: { conversationId: string }) {
  const gt = useGT();
  const locale = useLocale();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // A stored conversation is read after hydration (the page is a static
  // shell), so nothing renders until then rather than a flash of empty.
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const update = (id: string, change: (m: UiMessage) => UiMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? change(m) : m)));

  // `before` is the conversation so far when it was set in this same tick
  // (a restored conversation asking its `?q=`), which `messages` is not yet.
  const send = useCallback(
    async (text: string, before?: UiMessage[]) => {
      const user: UiMessage = { id: nextId(), role: "user", parts: [{ kind: "text", text }] };
      const reply: UiMessage = {
        id: nextId(),
        role: "assistant",
        parts: [],
        pending: true,
        status: { kind: "thinking" },
      };
      const history = toTurns([...(before ?? messages), user]);
      setMessages((ms) => [...ms, user, reply]);
      setBusy(true);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
      const controller = new AbortController();
      abort.current = controller;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ turns: history, locale }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line) as ChatEvent;
            if (event.type === "text") {
              update(reply.id, (m) => {
                const last = m.parts.at(-1);
                const parts: Part[] =
                  last?.kind === "text"
                    ? [...m.parts.slice(0, -1), { kind: "text", text: last.text + event.text }]
                    : [...m.parts, { kind: "text", text: event.text }];
                return { ...m, parts };
              });
            } else if (event.type === "status") {
              update(reply.id, (m) => ({
                ...m,
                status: { kind: event.status, ...(event.sql ? { sql: event.sql } : {}) },
              }));
            } else if (event.type === "view") {
              update(reply.id, (m) => ({
                ...m,
                parts: [
                  ...m.parts,
                  {
                    kind: "view",
                    ref: viewRef(event.data.view),
                    data: event.data,
                    ...(event.watch ? { watch: true } : {}),
                  },
                ],
              }));
            } else if (event.type === "error") {
              update(reply.id, (m) => ({ ...m, error: event.code ?? "unavailable" }));
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("chat failed", error);
          update(reply.id, (m) => ({ ...m, error: "unavailable" }));
        }
      } finally {
        update(reply.id, (m) => {
          const done: UiMessage = { ...m, pending: false };
          delete done.status;
          return done;
        });
        setBusy(false);
        abort.current = null;
      }
    },
    [messages, locale],
  );

  // Restore this conversation, then ask the question it was opened with
  // (once: the query string is dropped, so a reload does not ask again).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    // Anything not in the current shape (an older version of this page) is skipped.
    const saved = loadConversation<StoredMessage>(conversationId)?.filter((m) =>
      Array.isArray(m.parts),
    );
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!saved?.length) {
      setReady(true);
      if (q) void send(q.slice(0, 4000));
      return;
    }
    // Text shows at once; each view keeps its place as a placeholder until
    // its data arrives.
    const restored = saved.map((m): UiMessage => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      ...(m.error ? { error: m.error } : {}),
    }));
    setMessages(restored);
    setReady(true);
    // A follow-up asked from a shared view arrives as a saved conversation
    // holding that view, plus the question.
    if (q) void send(q.slice(0, 4000), restored);
    const ids = new Set(
      saved.flatMap((m) => m.parts.flatMap((p) => (p.kind === "view" ? [p.ref.id] : []))),
    );
    for (const id of ids) {
      void loadView(id).then((data) => {
        setMessages((ms) =>
          ms.map((m) => ({
            ...m,
            // A view that no longer loads is dropped rather than left spinning.
            parts: m.parts.flatMap((p): Part[] =>
              p.kind === "view" && p.ref.id === id ? (data ? [{ ...p, data }] : []) : [p],
            ),
          })),
        );
      });
    }
  }, [conversationId, send]);

  // Saved when a message is added and when an answer finishes, not on every
  // streamed token.
  const latest = useRef(messages);
  useEffect(() => {
    latest.current = messages;
  });
  useEffect(() => {
    if (ready && latest.current.length) {
      saveConversation(conversationId, latest.current.map(toStored));
    }
  }, [conversationId, ready, messages.length, busy]);

  const stop = () => abort.current?.abort();

  if (!ready) return <main id="main-content" tabIndex={-1} className="min-h-[calc(100dvh-54px)]" />;

  if (messages.length === 0) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-xl px-4 py-24 text-center sm:px-7"
      >
        <p className="text-ink-2">
          {gt(
            "This conversation is not saved in this browser. Conversations stay on the device they happened on.",
          )}
        </p>
        <Link
          href={localePath(locale, "/")}
          className="mt-4 inline-block text-accent hover:underline"
        >
          {gt("Start a new conversation")}
        </Link>
      </main>
    );
  }

  return (
    // At least a screen tall (less the 54px nav), so the box sits at the bottom
    // of the window even before the conversation fills it.
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-[calc(100dvh-54px)] max-w-4xl flex-col px-4 pt-6 sm:px-7"
    >
      {/* Conversation content stays out of session replays (see the privacy page). */}
      <div className="ph-no-capture flex-1 space-y-6 pb-8">
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        <div ref={bottom} />
      </div>
      <div className="sticky bottom-0 z-20 -mx-4 bg-surface/80 px-4 pt-2 pb-4 backdrop-blur-md sm:-mx-7 sm:px-7">
        <Composer onSend={send} onStop={stop} busy={busy} floating />
        <p className="mt-1.5 flex justify-between gap-3 px-1 text-[11px] text-ink-3">
          <span>{gt("Answers come from AWS's public price lists; check before you commit.")}</span>
          <Link href={localePath(locale, "/")} className="shrink-0 hover:text-ink">
            {gt("New conversation")}
          </Link>
        </p>
      </div>
    </main>
  );
}
