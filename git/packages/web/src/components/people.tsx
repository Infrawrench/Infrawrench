/** People and time, as rows name them. */
import { useEffect, useState } from "react";
import type { Signature, UserRef } from "@infrawrench/git-contract";
import { formatDateTime, relativeTime } from "../lib/format";
import { paths } from "../lib/paths";
import { safeImageUrl } from "../lib/safe-url";
import { AppLink } from "./AppLink";

/** Re-renders once a minute so "2 minutes ago" keeps up without a reload. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** `3 hours ago`, with the exact time as the tooltip and the machine-readable instant. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useMinuteTick();
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {relativeTime(iso, now)}
    </time>
  );
}

function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, 2);
  return letters.toUpperCase();
}

export interface AvatarProps {
  /** A display name or a slug: the initials and the tint come from it. */
  readonly name: string;
  readonly src?: string | null | undefined;
  readonly size?: number;
  /** Organisations are squares, people are circles. */
  readonly square?: boolean;
}

/** A picture when there is one, otherwise initials on a neutral tile. Decorative: name the person beside it. */
export function Avatar({ name, src, size = 20, square = false }: AvatarProps) {
  const shape = square ? "rounded" : "rounded-full";
  const picture = safeImageUrl(src);
  if (picture !== null) {
    return (
      <img
        src={picture}
        alt=""
        referrerPolicy="no-referrer"
        width={size}
        height={size}
        className={`shrink-0 ${shape} bg-surface-sunken object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }}
      className={`inline-flex shrink-0 select-none items-center justify-center ${shape} bg-accent-muted font-semibold text-accent-on-muted`}
    >
      {initials(name)}
    </span>
  );
}

/** A person by username, linked to their page; plain text when they have not claimed one. */
export function UserLink({
  user,
  avatar = false,
  className = "",
}: {
  user: UserRef;
  avatar?: boolean;
  className?: string;
}) {
  const label = user.username ?? user.displayName ?? "Unknown";
  const content = (
    <>
      {avatar ? <Avatar name={user.displayName ?? label} src={user.avatarUrl} size={16} /> : null}
      <span className="truncate">{label}</span>
    </>
  );
  if (user.username === null) {
    return (
      <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>{content}</span>
    );
  }
  return (
    <AppLink
      href={paths.namespace(user.username)}
      className={`inline-flex min-w-0 items-center gap-1.5 font-medium text-on-surface hover:underline ${className}`}
    >
      {content}
    </AppLink>
  );
}

/** A commit's author: the Infrawrench user when the email belongs to one, the written name otherwise. */
export function CommitAuthor({
  author,
  user,
  avatar = true,
}: {
  author: Signature;
  user: UserRef | null;
  avatar?: boolean;
}) {
  if (user !== null) return <UserLink user={user} avatar={avatar} />;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-on-surface">
      {avatar ? <Avatar name={author.name} size={16} /> : null}
      <span className="truncate" title={author.email}>
        {author.name}
      </span>
    </span>
  );
}
