import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

export function Badge(props: {
  tone?: "ok" | "warn" | "bad" | "idle";
  children: ReactNode;
}): JSX.Element {
  const tone = props.tone ?? "idle";
  const colors = {
    ok: "bg-[color-mix(in_srgb,var(--yuvi-ok)_16%,transparent)] text-[var(--yuvi-ok)]",
    warn: "bg-[color-mix(in_srgb,var(--yuvi-warn)_16%,transparent)] text-[var(--yuvi-warn)]",
    bad: "bg-[color-mix(in_srgb,var(--yuvi-bad)_16%,transparent)] text-[var(--yuvi-bad)]",
    idle: "bg-[var(--yuvi-accent-soft)] text-[var(--yuvi-muted)]"
  };
  return (
    <span
      className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", colors[tone])}
    >
      {props.children}
    </span>
  );
}
