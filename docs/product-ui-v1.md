# Product UI v1

Daily-use companion shell for YUVI. This is configuration and observation only.
Runtime, Memory, Cognition, and Phase 6/7 authority are unchanged.

## Research

| Product | Decision | Why |
| --- | --- | --- |
| Open WebUI | **ADAPT** connection model (URL, key, test, discover). **REJECT** admin/user split, Ollama management, accounts. |
| AnythingLLM | **ADAPT** local-first single-user settings and connection testing. **REJECT** workspace/RAG admin as YUVI Memory already exists. |
| LibreChat | **ADAPT** role-like model specs and custom endpoints. **REJECT** yaml-first UX and multi-user keys. |
| LobeChat | **ADAPT** chat-first desktop layout, command palette, TTS/STT settings. **REJECT** 70-provider marketplace and cloud sync. |

| Library | Decision |
| --- | --- |
| Radix primitives | **ADOPT** for accessible dialogs, tabs, switches. |
| shadcn-style local components | **ADOPT** owned in-repo, Tailwind 3, no CLI/Tailwind 4 migration. |
| Mantine | **REJECT** second styling system / framework lock-in. |
| React/Tailwind upgrades | **REJECT** not required. |

## Information architecture

- Chat / Home (Lumi companion first)
- Settings: General, Models & Providers, AI Routing, Voice, Vision, Memory, Capabilities, Companion, Appearance, Advanced
- Compact health in the header
- Diagnostics drawer (collapsed by default)
- Command palette (⌘K)

## Persistence

- Provider secrets and connection env: existing `.env.local` writer, 0o600, localhost-only product APIs
- UI preferences: `product-ui.json` beside the runtime env dir
- Precedence remains Environment > local UI config > defaults

## Honest deferred features

- Character supervisor / GLM-5.3-Flash role
- Cognition fast/deep split
- User-editable MCP server catalog
- Idle Dream and runtime compression as operational switches
