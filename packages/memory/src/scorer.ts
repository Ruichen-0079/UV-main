import type { Memory } from "./types.js";

export class MemoryScorer {
  scoreImportance(content: string): number {
    const trimmed = content.trim();
    if (!trimmed) {
      return 0;
    }

    return Math.min(1, Math.max(0.1, trimmed.length / 1000));
  }

  rank(memories: Memory[]): Memory[] {
    return [...memories].sort((left, right) => {
      const importanceDelta = right.importance - left.importance;
      if (importanceDelta !== 0) {
        return importanceDelta;
      }

      return right.lastAccessedAt.getTime() - left.lastAccessedAt.getTime();
    });
  }
}
