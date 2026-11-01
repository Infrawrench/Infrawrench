"use client";

import Link from "next/link";
import { T, Var, useGT, useLocale } from "gt-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { viewRef, type ChatEvent, type ChatTurn, type ViewData } from "@/lib/chat/types";
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
interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  views: { data: ViewData; watch?: boolean }[];
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

const STORAGE_KEY = "instances-chat:v1";

let counter = 0;
const nextId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * The service in the headline, rolling every few seconds: the outgoing name
 * slides up and out while the next slides up into the same slot, both at
 * once. Held still for reduced motion.
 */
function CyclingService() {
  // The name showing, and the one rolling out (null until the first change).
  const [{ i, previous }, setNames] = useState<{ i: number; previous: number | null }>({
    i: 0,
    previous: null,
  });
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(
      () => setNames(({ i: n }) => ({ i: (n + 1) % SERVICES.length, previous: n })),
      2600,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    // One grid cell holds both names; the clip hides each outside the line.
    // The padding keeps descenders (OpenSearch) inside the clip.
    <span className="inline-grid overflow-hidden pb-[0.15em] align-bottom -mb-[0.15em] text-accent">
      {previous !== null && (
        <span
          key={`out-${previous}`}
          aria-hidden="true"
          className="col-start-1 row-start-1 animate-[service-out_0.6s_ease-in-out_forwards]"
        >
          {SERVICES[previous]}
        </span>
      )}
      <span
        key={`in-${i}`}
        className={`col-start-1 row-start-1 ${previous !== null ? "animate-[service-in_0.6s_ease-in-out]" : ""}`}
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
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  autoFocus?: boolean;
  floating?: boolean;
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
        placeholder={gt("Ask about prices, specs, regions or history…")}
        aria-label={gt("Your question")}
        maxLength={4000}
        className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-ink-3"
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

function Message({ message }: { message: UiMessage }) {
  const gt = useGT();
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-surface-2 px-4 py-2.5 whitespace-pre-wrap text-ink">
          {message.text}
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="min-w-0 space-y-4">
        {message.text && <Markdown text={message.text} />}
        {message.views.map((v) => (
          <ViewCard key={v.data.view.id} data={v.data} watch={v.watch ?? false} />
        ))}
        {message.pending && message.status && <Status status={message.status} />}
        {message.error && (
          <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm">
            {message.error === "rate_limited"
              ? gt("That is a lot of questions in a short time. Wait a minute and ask again.")
              : message.error === "refused"
                ? gt(
                    "I can't help with that one. Ask me about AWS instance types and their prices.",
                  )
                : gt("Something went wrong answering that. Try again in a moment.")}
          </p>
        )}
      </div>
    </div>
  );
}

const toTurns = (messages: UiMessage[]): ChatTurn[] =>
  messages
    .filter((m) => !m.pending && (m.text || m.views.length))
    .map((m) => ({
      role: m.role,
      text: m.text,
      ...(m.views.length ? { views: m.views.map((v) => viewRef(v.data.view)) } : {}),
    }));

/**
 * The chat. On the home page it starts empty, with the headline, the box and
 * suggestions; once asked, it becomes a conversation with the box floating at
 * the bottom. `/v/<id>` starts it with a saved view as the first answer.
 */
export function Chat({ initial, persist = false }: { initial?: ViewData; persist?: boolean }) {
  const gt = useGT();
  const locale = useLocale();
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    initial ? [{ id: "initial", role: "assistant", text: "", views: [{ data: initial }] }] : [],
  );
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // The home page's conversation survives going to an instance page and back.
  useEffect(() => {
    if (!persist) return;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) setMessages(JSON.parse(saved) as UiMessage[]);
    } catch {
      // Private mode or a stale shape: start fresh.
    }
  }, [persist]);
  useEffect(() => {
    if (!persist || busy) return;
    try {
      if (messages.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Quota or private mode; only a convenience.
    }
  }, [messages, busy, persist]);

  const update = (id: string, change: (m: UiMessage) => UiMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? change(m) : m)));

  const send = useCallback(
    async (text: string) => {
      const user: UiMessage = { id: nextId(), role: "user", text, views: [] };
      const reply: UiMessage = {
        id: nextId(),
        role: "assistant",
        text: "",
        views: [],
        pending: true,
        status: { kind: "thinking" },
      };
      const history = toTurns([...messages, user]);
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
            if (event.type === "text")
              update(reply.id, (m) => ({ ...m, text: m.text + event.text }));
            else if (event.type === "status") {
              update(reply.id, (m) => ({
                ...m,
                status: { kind: event.status, ...(event.sql ? { sql: event.sql } : {}) },
              }));
            } else if (event.type === "view") {
              update(reply.id, (m) => ({
                ...m,
                views: [...m.views, { data: event.data, ...(event.watch ? { watch: true } : {}) }],
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

  // `/?q=...` asks straight away, so questions can be linked.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || initial) return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    asked.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    void send(q.slice(0, 4000));
  }, [send, initial]);

  const stop = () => abort.current?.abort();

  if (messages.length === 0) {
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
          <Composer onSend={send} onStop={stop} busy={busy} autoFocus />
        </div>
        <div className="mt-6">
          <Suggestions onPick={send} />
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
        <p className="mt-1.5 flex justify-between px-1 text-[11px] text-ink-3">
          <span>{gt("Answers come from AWS's public price lists; check before you commit.")}</span>
          {persist && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setMessages([])}
              className="hover:text-ink disabled:opacity-50"
            >
              {gt("New conversation")}
            </button>
          )}
        </p>
      </div>
    </main>
  );
}
