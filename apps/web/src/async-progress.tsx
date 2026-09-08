import { t } from "./locale.js";
/** No percentage: these operations expose pending state, not measured completion. */
export function AsyncProgress(props: { label?: string }): JSX.Element {
  const label = t(props.label ?? "Loading…");
  return (
    <div role="status" aria-live="polite" className="text-sm">
      <span>{label}</span>
      <progress aria-label={label} />
    </div>
  );
}
