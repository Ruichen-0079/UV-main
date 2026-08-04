export type AsyncDataSnapshot<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

export class AsyncRequestGeneration {
  private generation = 0;
  private mounted = false;

  mount(): void {
    this.mounted = true;
  }

  cleanup(): void {
    this.mounted = false;
    this.generation += 1;
  }

  next(): number {
    this.generation += 1;
    return this.generation;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  isCurrent(generation: number): boolean {
    return this.mounted && generation === this.generation;
  }
}

export function beginAsyncDataRefresh<T>(
  current: AsyncDataSnapshot<T>,
  preserveData: boolean
): AsyncDataSnapshot<T> {
  return {
    data: preserveData ? current.data : null,
    error: null,
    loading: true
  };
}

export function completeAsyncDataSuccess<T>(data: T): AsyncDataSnapshot<T> {
  return { data, error: null, loading: false };
}

export function completeAsyncDataFailure<T>(
  current: AsyncDataSnapshot<T>,
  error: string
): AsyncDataSnapshot<T> {
  return { data: current.data, error, loading: false };
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
