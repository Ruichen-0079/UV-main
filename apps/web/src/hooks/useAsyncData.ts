import { useCallback, useEffect, useRef, useState } from "react";
import {
  AsyncRequestGeneration,
  beginAsyncDataRefresh,
  completeAsyncDataFailure,
  completeAsyncDataSuccess,
  isAbortError,
  type AsyncDataSnapshot
} from "./async-data-state.js";

export type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh(): Promise<T | null>;
};

export type UseAsyncDataOptions = {
  preserveDataOnRefresh?: boolean;
};

export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  options: UseAsyncDataOptions = {}
): AsyncState<T> {
  const [state, setState] = useState<AsyncDataSnapshot<T>>({
    data: null,
    error: null,
    loading: true
  });
  const loaderRef = useRef(loader);
  const preserveDataRef = useRef(options.preserveDataOnRefresh ?? true);
  const generationRef = useRef(new AsyncRequestGeneration());
  const abortControllerRef = useRef<AbortController | null>(null);
  loaderRef.current = loader;
  preserveDataRef.current = options.preserveDataOnRefresh ?? true;

  const refresh = useCallback(async () => {
    if (!generationRef.current.isMounted()) return null;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const requestGeneration = generationRef.current.next();
    setState((current) => beginAsyncDataRefresh(current, preserveDataRef.current));
    try {
      const next = await loaderRef.current(controller.signal);
      if (generationRef.current.isCurrent(requestGeneration)) {
        setState(completeAsyncDataSuccess(next));
      }
      return next;
    } catch (caught) {
      if (
        generationRef.current.isCurrent(requestGeneration) &&
        !controller.signal.aborted &&
        !isAbortError(caught)
      ) {
        setState((current) =>
          completeAsyncDataFailure(
            current,
            caught instanceof Error ? caught.message : "Request failed"
          )
        );
      }
      return null;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    generationRef.current.mount();
    void refresh();
    return () => {
      generationRef.current.cleanup();
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [refresh, ...deps]);

  return { ...state, refresh };
}
