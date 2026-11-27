import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AppLink, type AppLinkProps } from "./AppLink";
import { Spinner } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover border border-transparent",
  secondary:
    "border border-border bg-surface-raised text-on-surface hover:bg-surface-sunken hover:border-border-strong",
  ghost: "border border-transparent text-on-surface-secondary hover:bg-surface-sunken",
  danger: "border border-danger/40 text-danger hover:bg-danger/10",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-3 py-1.5 text-xs",
};

/** The classes of a button, for the rare element that is neither a `Button` nor a `ButtonLink`. */
export const buttonClass = (
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className = "",
): string => `${base} ${variants[variant]} ${sizes[size]} ${className}`.trim();

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner and disables the button while its action runs. */
  readonly busy?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={buttonClass(variant, size, className)}
    >
      {busy ? <Spinner size={12} /> : null}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends AppLinkProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/** A link that looks like a button: navigation, never an action. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonLinkProps) {
  return <AppLink {...rest} className={buttonClass(variant, size, className)} />;
}
