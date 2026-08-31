import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/cn.js";

export function Switch(props: {
  checked: boolean;
  onCheckedChange(value: boolean): void;
  disabled?: boolean;
  label: string;
  description?: string;
}): JSX.Element {
  return (
    <label className="flex items-start justify-between gap-4 rounded-[14px] border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] p-3">
      <span>
        <span className="block text-sm font-medium">{props.label}</span>
        {props.description ? (
          <span className="mt-1 block text-xs text-[var(--yuvi-muted)]">{props.description}</span>
        ) : null}
      </span>
      <SwitchPrimitive.Root
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full border border-[var(--yuvi-line)] bg-[var(--yuvi-line)] data-[state=checked]:bg-[var(--yuvi-accent)]"
        )}
      >
        <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[22px]" />
      </SwitchPrimitive.Root>
    </label>
  );
}
