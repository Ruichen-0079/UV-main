import type * as React from "react";

export function PageShell(props: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-normal">{props.title}</h2>
        <p className="mt-1 text-sm text-ink-500">{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  );
}

export function Panel(props: {
  title: string;
  children: React.ReactNode;
  badge?: string;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      <div className="flex min-h-12 items-center justify-between border-b border-ink-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          {props.badge && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              {props.badge}
            </span>
          )}
        </div>
        {props.actions}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

export function StatusCard(props: {
  title: string;
  status: string;
  detail: string;
  mock?: boolean;
}): JSX.Element {
  return (
    <div className="panel p-4">
      <div className="label">{props.title}</div>
      <div className="mt-3 flex items-center gap-2">
        <StatusDot status={props.status} />
        <div className="text-lg font-semibold">{props.status}</div>
      </div>
      <div className="mt-2 text-sm text-ink-500">{props.detail}</div>
      {props.mock && <div className="mt-3 text-xs font-medium text-amber-700">Mock mode</div>}
    </div>
  );
}

export function StatusDot(props: { status: string }): JSX.Element {
  const color =
    props.status === "healthy"
      ? "bg-emerald-500"
      : props.status === "loading"
        ? "bg-cyan-500"
        : props.status === "error" || props.status === "unavailable"
          ? "bg-rose-500"
          : "bg-amber-500";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

export function Pill(props: { status: string }): JSX.Element {
  return (
    <span className="inline-flex rounded-full bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-700">
      {props.status}
    </span>
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

export function EmptyState(props: { title: string; message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-ink-200 bg-ink-50 px-4 py-8 text-center">
      <div className="font-semibold">{props.title}</div>
      <div className="mt-1 text-sm text-ink-500">{props.message}</div>
    </div>
  );
}

export function Field(props: { label: string; children: React.ReactNode }): JSX.Element {
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
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 rounded-md border border-ink-100 p-3">
      <input
        className="mt-1 h-4 w-4"
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm font-semibold">{props.label}</span>
        <span className="block text-xs leading-5 text-ink-500">{props.note}</span>
      </span>
    </label>
  );
}

export function Definition(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="mb-3">
      <div className="label">{props.label}</div>
      <div className="mt-1 font-mono text-sm text-ink-700">{props.value}</div>
    </div>
  );
}
