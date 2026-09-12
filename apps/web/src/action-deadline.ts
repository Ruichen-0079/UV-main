import { t } from "./locale.js";

/** Bound UI waiting even when a native command or transport does not settle. */
export async function withActionDeadline<T>(
  work: Promise<T>,
  milliseconds = 30_000,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              t(
                "Request timed out. The operation may still be completing; refresh its status before retrying."
              )
            )
          );
          onTimeout?.();
        }, milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
