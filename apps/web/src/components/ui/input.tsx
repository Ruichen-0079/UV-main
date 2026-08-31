import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

const fieldClass =
  "w-full rounded-[12px] border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] px-3 py-2 text-sm text-[var(--yuvi-ink)] placeholder:text-[var(--yuvi-muted)]";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(fieldClass, "h-10", className)} {...props} />;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldClass, "min-h-20", className)} {...props} />;
  }
);

export function Field(props: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--yuvi-muted)]">
        {props.label}
      </span>
      {props.children}
      {props.hint ? <span className="text-xs text-[var(--yuvi-muted)]">{props.hint}</span> : null}
    </label>
  );
}
