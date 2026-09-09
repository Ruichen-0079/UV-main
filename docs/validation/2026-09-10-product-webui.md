# Product WebUI rebaseline and KDE tray validation

Starting remote main: `cb1ca5d69c271e81d59bc617e4bda56689cc4dc3`.
The local checkout was clean and behind remote main. The feature branch starts at remote main. No open PRs; Check and Linux Persistence were green. Remote main was checked again after implementation and remained unchanged.

## Product decisions

The WebUI is a settings/control surface, with the expressive character and subtitles remaining in their existing separate windows. A persistent navigation rail replaces the overflowing topbar. Overview gives first-run actions and concise health, with evidence available in disclosures. AI & connections groups providers, models and assignments into three steps backed by the same configuration component and draft. Switching steps retains unsaved assignments.

People & voices, Memory and Conversation have independent destinations. Companion groups window settings and the installed model library; installed models precede import, and extracted-directory import and sample licensing are disclosures. Subtitle and Vision have their own destinations. System holds language, local service settings, connection troubleshooting and the existing developer console. Desktop-only Subtitle controls have an explicit explanation in browser mode.

Muted green, neutral surfaces, restrained dividers, consistent fields and clearer headings replace the warm gradient/card-heavy product shell. Navigation becomes a scrollable strip on narrow screens. English and zh-CN use the existing locale dictionary; dynamic navigation strings have translation coverage.

Removed the unused provider-card component and its private helpers (201 lines), obsolete product CSS rules, duplicated page heroes and topbar navigation. The configuration JSX is expanded from compressed one-line sections for maintainability. Existing provider, model, route, profile, voice, memory and desktop settings writers remain authoritative. No backend or Rust product code changed.

## Validation

- `pnpm check`: passed.
- `pnpm --filter @companion/web build`: passed. Existing large-bundle advisory remains.
- `pnpm test`: passed across the workspace; existing skipped tests remain skipped.
- Final focused frontend run: 77 files, 671 tests passed, including navigation, draft retention, failed-load retry and locale coverage.
- Real KDE session: `pnpm desktop:close-tray:linux` passed. KWin compositor close events and Plasma StatusNotifierItem/dbusmenu messages exercise real windows and tray actions, not mocked desktop behavior.
- Tray has Active status, an available icon and exactly one app registration. Main, WebUI, Companion and Subtitle show/hide and close-as-hide pass. Companion is cycled three times. Reopening reuses windows. Unlock Subtitle clears a seeded locked presentation file on the live window without an apply error. Menu remains usable when windows are closed. Repeated Quit is harmless; exit code 0, supervisor state cleaned, zero owned descendants, no stale tray registration.
- Extended the lifecycle harness to isolate runtime env files as well as HOME/XDG roots. Repository `.env.local` previously contaminated the supposedly isolated run and started PostgreSQL-dependent services. This is a test-infrastructure fix; product lifecycle behavior was left alone. Rebuilt stale Rust artifacts referring to a former checkout path before validation.
- Visual browser inspection against a real isolated Runtime at desktop-sized 1000×720 and 780×640 and narrow 390×844: overview/setup, AI forms, profile/voices, Memory, Conversation, Companion library and System. English and Chinese inspected. Narrow layout document width equals scroll width; navigation alone scrolls horizontally. Native tray validation is protocol/compositor-based; no native screenshot or pixel click claim is made.

No external providers were called for this presentation pass, and no real API credentials or user profiles were edited.

## Resumed delivery audit

Recovered the uncommitted implementation on `product/webui-rebaseline` in `/home/ruichen/Projects/YUVI`; remote main still matched the starting SHA. No rebaseline commit, remote feature branch or open PR existed. The unrelated older stash and untracked generated `proactive-policy.json` were preserved and excluded from delivery.

Reviewed every changed file against refreshed remote main, including a formatting-normalized comparison of the large configuration and settings components. Preserved the redesign and existing settings writers. Completed three small presentation fixes: actually display the already-defined translated service-type labels while preserving adapter IDs as option values, update the stale People & Memory reference, and reset vertical scroll when changing destinations so the new heading remains visible.

Fresh validation in the resumed session:

- `pnpm test`: full workspace and root Node tests passed (existing skips retained).
- `pnpm check`, `pnpm --filter @companion/web build`, and all 77 frontend test files / 671 tests passed after the final UI changes; this includes localization coverage. The old navigation-copy assertion was updated with the copy.
- Chromium inspection against the recovered isolated Runtime on port 6123 / WebUI on 5175: all nine destinations and all three AI steps in English and zh-CN at 1000×720 and 390×844, with no document horizontal overflow. Inspected rendered overview, AI forms, People, Memory, Conversation, Companion and System. Service-type labels retain the original adapter values.
- `node --check scripts/desktop-close-tray-lifecycle-linux.mjs` and `git diff --check`: passed.
- Recovered `/tmp/yuvi-tray-final.log` confirms the full real KDE PASS described above, including icon/registration, Unlock Subtitle and Quit cleanup. Recovered Rust test log also records a passing run. Neither the tray harness nor desktop implementation changed during the resumed audit; copy/navigation-only follow-ups do not invalidate lifecycle evidence. No additional real KDE run was needed.

No backend, Rust, dependencies or runtime state authority changes. No provider calls, credential edits or profile writes were needed for the resumed visual checks. Browser inspection does not claim a fresh native pixel-level desktop review. The existing frontend bundle-size advisory remains.
