import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

export function Badge(props: {
  tone?: "ok" | "warn" | "bad" | "idle";
  children: ReactNode;
}): JSX.Element {
  const tone = props.tone ?? "idle";
  const colors = {
    ok: "bg-emerald-50 text-[var(--yuvi-ok)]",
    warn: "bg-amber-50 text-[var(--yuvi-warn)]",
    bad: "bg-rose-50 text-[var(--yuvi-bad)]",
    idle: "bg-[var(--yuvi-accent-soft)] text-[var(--yuvi-muted)]"
  };
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", colors[tone])}>
      {props.children}
    </span>
  );
}
