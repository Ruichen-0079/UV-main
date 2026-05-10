# @companion/core

Runtime orchestration and agent loop boundary.

Responsibilities:

- Coordinate events, memory retrieval, prompt building, and provider calls.
- Depend only on interfaces and registries.
- Avoid direct imports of DeepSeek, xAI, Alibaba, or other vendor implementation classes.
- Emit runtime output as protocol events.
