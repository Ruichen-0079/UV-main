import type { DesktopRuntimeBindingDto } from "./service-supervisor-client.js";

/** Poll the existing Desktop projection; readiness/ownership remain its decision. */
export async function waitDesktopBinding(
  read: () => Promise<DesktopRuntimeBindingDto | null>,
  waiting: (detail: string) => void,
  options: { now?: () => number; sleep?: () => Promise<void>; timeoutMs?: number } = {}
): Promise<DesktopRuntimeBindingDto> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (() => new Promise(resolve => setTimeout(resolve, 500)));
  const deadline = now() + (options.timeoutMs ?? 175_000);
  for (;;) {
    const binding = await read();
    if (!binding) throw new Error("Desktop Runtime binding projection is unavailable.");
    if (binding.mode !== "attach" || (binding.ready && binding.runtimeUrl)) return binding;
    if (now() >= deadline) throw new Error(binding.error ?? "Timed out waiting for this Desktop's Runtime.");
    waiting(binding.error ?? "Waiting for owned services to start.");
    await sleep();
  }
}
