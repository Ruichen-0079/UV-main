export const MemoryTypes = [
  "working",
  "episodic",
  "semantic",
  "emotional",
  "procedural"
] as const;

export type MemoryType = typeof MemoryTypes[number];

export type Memory = {
  id: string;
  type: MemoryType;
  content: string;
  summary: string | null;
  embedding: number[] | null;
  importance: number;
  emotionValence: number;
  emotionArousal: number;
  source: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
};

export type CreateMemoryInput = {
  type: MemoryType;
  content: string;
  summary?: string | null;
  embedding?: number[] | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  source: string;
  tags?: string[];
};

export type MemorySearchQuery = {
  text?: string;
  embedding?: number[];
  types?: MemoryType[];
  tags?: string[];
  limit?: number;
};

export type Entity = {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
};

export type CreateEntityInput = {
  name: string;
  type: string;
};

export type Relation = {
  id: string;
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight: number;
  createdAt: Date;
};

export type CreateRelationInput = {
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight?: number;
};

export type MemoryQuery = {
  sessionId?: string;
  text: string;
  limit?: number;
};
