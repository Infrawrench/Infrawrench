/**
 * Form controls in the app's density: small text, a 1px border, the page
 * surface inside. Every control is labelled: wrap it in `Field`, or give it an
 * `aria-label` when the label is not shown.
 */
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon } from "./icons";

export const inputClass =
  "w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-on-surface placeholder:text-on-surface-faint focus:border-border-strong disabled:opacity-60 aria-[invalid=true]:border-danger";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${inputClass} ${className}`} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`${inputClass} ${className}`} />;
}

export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={`${inputClass} pr-6 ${className}`} />;
}

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** The accessible name; the placeholder is not one. */
  readonly label: string;
}

export function SearchInput({ label, className = "", ...rest }: SearchInputProps) {
  return (
    <div className={`relative ${className}`}>
      <Icon
        name="search"
        size={13}
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-faint"
      />
      <input {...rest} type="search" aria-label={label} className={`${inputClass} pl-7`} />
    </div>
  );
}

export interface FieldProps {
  readonly label: string;
  /** A constraint the person needs before typing (allowed characters, a limit). */
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
  readonly optional?: boolean;
  /** Receives the ids to put on the control. */
  readonly children: (control: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
  }) => ReactNode;
}

/** A label, its control, and the hint or error under it, wired by id. */
export function Field({ label, hint, error, optional = false, children }: FieldProps) {
  const id = useId();
  const hasError = error !== undefined && error !== null && error !== "";
  const describedBy = hasError ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-on-surface">
        {label}
        {optional ? <span className="ml-1 font-normal text-on-surface-faint">optional</span> : null}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": hasError || undefined })}
      {hasError ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="text-xs text-on-surface-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly label: ReactNode;
}

export function Checkbox({ label, className = "", ...rest }: CheckboxProps) {
  return (
    <label className={`flex items-center gap-2 text-xs text-on-surface ${className}`}>
      <input {...rest} type="checkbox" className="size-3.5 accent-[var(--color-accent)]" />
      <span>{label}</span>
    </label>
  );
}

export interface RadioCardsProps<T extends string> {
  readonly legend: string;
  readonly name: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly detail?: string;
    readonly icon?: ReactNode;
    readonly disabled?: boolean;
  }>;
}

/** A small set of exclusive choices, each a row with a line of detail. */
export function RadioCards<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: RadioCardsProps<T>) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-medium text-on-surface">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={`flex items-start gap-2 rounded border px-2.5 py-2 text-xs ${
            value === option.value ? "border-border-strong bg-surface-raised" : "border-border"
          } ${option.disabled === true ? "opacity-60" : "cursor-pointer"}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
            className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium text-on-surface">
              {option.icon}
              {option.label}
            </span>
            {option.detail !== undefined ? (
              <span className="block text-on-surface-muted">{option.detail}</span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
