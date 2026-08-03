import type { ReactNode } from "react";

/** Small UI primitives shared by the desktop surfaces. Kept local to avoid
 *  coupling the dashboard page shell to the new desktop entry points. */

export function Panel(props: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      <div className="flex min-h-12 items-center justify-between border-b border-ink-100 px-4 py-3">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        {props.actions}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

export function Field(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="label">{props.label}</span>
      {props.children}
    </label>
  );
}

export function Toggle(props: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
  note: string;
  testId?: string;
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 rounded-md border border-ink-100 p-3">
      <input
        className="mt-1 h-4 w-4"
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        data-testid={props.testId}
      />
      <span>
        <span className="block text-sm font-semibold">{props.label}</span>
        <span className="block text-xs leading-5 text-ink-500">{props.note}</span>
      </span>
    </label>
  );
}

export function Notice(props: {
  tone: "info" | "error";
  title: string;
  message: string;
}): JSX.Element {
  const styles =
    props.tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : "border-cyan-200 bg-cyan-50 text-cyan-800";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      <strong>{props.title}:</strong> {props.message}
    </div>
  );
}

export function Pill(props: { status: string }): JSX.Element {
  return (
    <span className="inline-flex rounded-full bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-700">
      {props.status}
    </span>
  );
}

export function EmptyState(props: { title: string; message: string }): JSX.Element {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center text-center">
      <div className="text-sm font-semibold text-ink-700">{props.title}</div>
      <div className="mt-1 text-xs text-ink-500">{props.message}</div>
    </div>
  );
}
