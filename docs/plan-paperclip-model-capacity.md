# Plan: paperclip-model-capacity

Build a Paperclip plugin that caps concurrent agent runs per model pool, queues the overflow with native blockers, moves waiting work to other pools, and shows host health and free-tier quota.

- **Date:** 2026-10-27
- **Source PRD:** `docs/prd-paperclip-model-capacity.md` (revised 2026-10-27)
- **Repo:** `coma-toast/paperclip-model-capacity` (public, MIT).
- **Builders:** Paperclip agents. Each step below is sized as one agent task with its own done-check.
- **Target host:** Paperclip `2026.1026.0-nightly.0`, plugin SDK `@paperclipai/plugin-sdk` of the same version.

## Context (what exploration found)

Paths are inside the installed Paperclip CLI. `SDK` = `…/node_modules/@paperclipai/plugin-sdk`, `SERVER` = `…/@paperclipai/server/dist`, `SHARED` = `…/@paperclipai/shared/dist`, under `$(readlink -f ~/.paperclip/cli/current)`.

**Scaffold and build**
- `paperclipai plugin init <pkg> --template default` generates:
  - `src/manifest.ts`, `src/worker.ts`, `src/ui/index.tsx`
  - `tests/plugin.spec.ts`, `vitest.config.ts`
  - `esbuild.config.mjs` (uses `createPluginBundlerPresets` from `@paperclipai/plugin-sdk/bundlers`)
  - tsconfig: ES2022, NodeNext, strict, `jsx: react-jsx`
  - the `"paperclipPlugin"` block in package.json
- Output: `dist/manifest.js`, `dist/worker.js` (node24 ESM) and `dist/ui/index.js` (React and the SDK UI kept external).
- **Install:** `paperclipai plugin install <path> --local` or from npm. A local-path install hot-reloads when `dist/` is rebuilt (the server logs `plugin-dev-watcher`).
- **Reference plugin:** `@tomismeta/paperclip-aperture` 0.6.0, (installed under `~/.paperclip/plugins/node_modules/`). It shows the patterns to copy:
  - `definePlugin({ multiCompanyConfig: true, setup, onHealth })` plus `runWorker(plugin, import.meta.url)`;
  - one versioned JSON blob per scope in `ctx.state`;
  - `ctx.data.register`, `ctx.actions.register` and `ctx.streams` driving `usePluginData`, `usePluginAction` and `usePluginStream`;
  - logs as `ctx.logger.warn(msg, {companyId, error})`.

**Plugin SDK surface** (`SDK/dist/types.d.ts`, `define-plugin.d.ts`)
- **Manifest** `PaperclipPluginManifestV1` (`SHARED/types/plugin.d.ts:600`):
  - `capabilities`, `jobs` (`{jobKey, displayName, schedule: cron}`), `instanceConfigSchema` (JSON Schema)
  - `ui.slots` (`page`, `dashboardWidget`, `detailTab` with `entityTypes:["issue"]`, `settingsPage`)
  - `database.coreReadTables`
- **Events:** `agent.run.started|finished|failed|cancelled`.
  - Payload: `{runId, agentId, status, issueId, error, errorCode, startedAt, finishedAt}`. **No model field.** `failed` also covers timeouts.
  - `issue.updated` carries `changes` and `_previous`.
- **Agents:** `ctx.agents.get/list` returns the full `adapterConfig` (so `.model`) and `runtimeConfig`.
- **Issues:**
  - Read: `ctx.issues.get/list` include `assigneeAdapterOverrides`, `blockedBy`, `labels`, `activeRun`, `priority` and `status`.
  - Blockers: `ctx.issues.relations.addBlockers/removeBlockers` (`issue.relations.write`).
  - Write: `ctx.issues.create`, `update` (`labelIds`, `blockedByIssueIds`), `requestWakeup` (`issues.wakeup`) and `createComment`.
- **Other ctx clients:**
  - `ctx.state.get/set/delete` (no list; scopes `instance`, `company`, `issue`, …)
  - `ctx.secrets.resolve(ref, {companyId, configPath})`. Refs must be bound in company config at a `format:"secret-ref"` path.
  - `ctx.http.fetch`, `ctx.activity.log`, `ctx.jobs.register`
  - `ctx.metrics.write`: plugin log rows only, not Prometheus.
- **Testing:** `createTestHarness({manifest, config})` from `@paperclipai/plugin-sdk/testing`.
  - It provides `seed`, `emit`, `runJob`, `getData`, `performAction` and `getState`, and records logs, activity and metrics.
  - Capabilities are enforced.
  - `http.fetch` hits the real `fetch`, so stub it. `secrets.resolve` returns `resolved:<ref>`.

**Server behavior that shapes the design** (`SERVER`)
- **An open blocker stops new runs.**
  - `enqueueWakeup` (`services/heartbeat/queue.js:2717-2764`) records an `issue_dependencies_blocked` skip and creates no run.
  - A run still `queued` is cancelled at claim time if blockers are open (`queue.js:664-672`, `1154-1163`).
  - **Exceptions:**
    - human comment and mention wakes still start a run (`issue-tree-control.js:11-15`);
    - a run already claimed is never stopped.
  - Only a `done` blocker counts as resolved; `cancelled` does not (`services/issues.js:1476-1481`).
- **`requestWakeup` throws** while any blocker is unresolved (`plugin-host-services.js:2056-2059`).
- **Removing a blocker does not wake the task** (`issue_blockers_resolved` fires when a blocker becomes `done`). So release = `removeBlockers` + `requestWakeup`.
- **`issue.assignment_wakeup_requested` can't be used to intercept wakes.** It fires only for the plugin's own `requestWakeup`, after the run is queued or started. Its `payload.runId` is the caller's run, not the new one; use `requestWakeup`'s return value `{queued, runId}`.
- **Effective model** = issue `assigneeAdapterOverrides.adapterConfig.model` if the assignee matches, else the agent's `adapterConfig.model` (`heartbeat.js:1399-1401`, `1711-1721`). Runs store the model actually used in `usage_json.model` at completion.
- **Model override write:**
  - SDK `issues.update`'s TypeScript type leaves out `assigneeAdapterOverrides`, but the RPC patch is `Record<string, unknown>` and the host passes it through (`plugin-host-services.js:1823-1842`). Untested.
  - REST `PATCH /api/issues/:id` accepts it from any actor that can edit the issue. Board API keys have no scopes; they carry full user access.
- **Labels:** created only through REST `POST /api/companies/:id/labels`. The SDK can only attach them by `labelIds` (replacing the whole set).
- **Per-agent concurrency:** `maxConcurrentRuns` (default 20, range 1–50) is enforced at run start (`queue.js:1313-1336`). Over the cap, a run stays `queued`.

**Example deployment (used in the rollout steps; not hard-coded)**
- **gpu host:** llama.cpp server with one slot, reached by agents as `gateway/gpu` through a LiteLLM gateway; also used for tasks pinned to private models.
- **laptop host:** Ollama; often offline.
- **LiteLLM gateway** with a `free` pool of several free cloud deployments (OpenRouter, Groq, NVIDIA NIM, Gemini), each with an RPM cap, and a fallback `free` → `gpu`.
- **Agents calling free models directly** (not through the gateway), e.g. `opencode/*-free`.
- **An existing polling routine or script** that limits the gpu host today, to be retired when the plugin enforces.

## Requirements

All PRD requirements stand, at their PRD priorities (47 MUST, 7 SHOULD). Changes and decisions made in planning (2026-10-27):

| PRD item | Planning decision |
|---|---|
| C1 hold mechanism | **Proactive blockers.** When a pool reaches its limit, the plugin adds the pool's queue blocker to every open, not-running task in that pool. It doesn't wait for a wake, because wakes can't be intercepted. Human comment wakes still start runs (counted as B4). |
| C1 label | Attach an **operator-chosen existing label** if one is set in settings. Otherwise use the blocker only (plugins can't create labels). |
| C3 release | `relations.removeBlockers` + `requestWakeup`; store the returned `runId`. |
| B2 counting | Read the core `heartbeat_runs` table read-only (`database.coreReadTables`) every sweep and at startup. Events drive the fast path. |
| D2 override write | Try `ctx.issues.update` with `assigneeAdapterOverrides` first (startup self-test). If that fails, use REST with a board API token from a secret ref. |
| A1/A3 config | **Pool definitions live in plugin instance state**, edited on the settings page. Per-company `instanceConfigSchema` holds only that company's secret refs, alert task, label and webhook. |
| G4 Prometheus | **Deferred to v2.** v1 alerts go to the UI, the standing task, the activity log and the webhook. |
| Phasing | **P1:** pools, probes, gating, widget, page, settings, alerts (UI, task, activity). **P2:** overflow + revert, task detail tab, webhook. **P3:** quota sources, quota UI, Prometheus. |

**Out of scope** (from the PRD): request-level limits, replacing gateway routing, cancelling runs, editing agent models, billing, managing model servers, Paperclip versions older than 2026.1026.0.

## Approach

**Scheduler core with no I/O, wrapped by adapters.**
- All decisions live in a pure `scheduler` module: `decide(snapshot, config, now) → actions[]`. The snapshot holds pools, running runs, held tasks, host status, quota and the time. Actions are `hold`, `release`, `overflow`, `restore`, `alert`.
- A thin `executor` applies the actions through the SDK, or only logs them in observe mode.
- Events (`agent.run.*`, `issue.updated`) and the 1-minute job both build a snapshot and call `decide`, so the fast path and the sweep share one code path.
- **Why:** it makes the hard part (ordering, limits, privacy, overflow triggers) unit-testable without Paperclip, and observe mode becomes "skip the executor".

**Gating with native blockers.**
- Each pool (per company, since blockers are issues) gets a standing task `<pool> queue`, created by the plugin.
- When `running + released-pending ≥ available`, every open, unpinned or pinned, not-running, non-exempt task in that pool gets the blocker.
- Releasing removes the blocker from the head of the queue and wakes it.
- **Rejected:** pausing agents (freezes all of an agent's tasks, fights other pause reasons); intercepting wakes (no hook exists).

**Counting from `heartbeat_runs`.** Events alone drift when missed and can't rebuild after a restart. A read-only query on `heartbeat_runs` (`status in ('queued','running')`, joined to the issue and agent) is the source of truth for every sweep.

**Effective model.** Resolve it in one function, `effectiveModel(issue, agent)`. Cache agents for 60 s and drop the cache on `agent.updated` events.

**Probes** run in the worker on their own interval (default 30 s) using `ctx.http.fetch` with a 5 s timeout, and write host status to instance state. Each engine has its own small adapter with one interface: `probe(host) → {up, slotsTotal?, slotsBusy?}`.

**Config split.**
- Instance state holds pools, hosts and scheduler settings, the same for all companies.
- Company config holds secret refs (LiteLLM, OpenRouter, board token, host auth), alert task id, label id and webhook URL. The host only resolves secret refs bound in company config.

## Style guide notes (`~/git/STYLEGUIDE.md`, TypeScript and React sections)

- Arrow functions everywhere (`const decide = (…) => …`). Interfaces for object shapes, `type` for unions (`type PoolPrivacy = 'private' | 'shared'`).
- Naming: camelCase for variables and functions, PascalCase for components and types, UPPER_SNAKE_CASE for constants (`DEFAULT_PROBE_INTERVAL_MS`). Component files in PascalCase (`DashboardWidget.tsx`).
- Imports grouped: React, third-party, icons, types, local components, utilities.
- Compact code; blank lines only between logical blocks. Named exports for modules. **Exception:** UI slot components are named exports because the manifest's `exportName` requires it. The guide's default-export rule is a React Admin convention that doesn't apply here.
- Error handling: try/catch with context. The worker logs `ctx.logger.warn('…', {companyId, poolId, error: e instanceof Error ? e.message : String(e)})` (the Aperture pattern). Never log secret values or task content.
- Comments explain why, not what.

## Detailed implementation steps

Each step is one Paperclip task. "Done when" is the check an agent must show (command output) in its task comment. Every task works on its own branch from `origin/main` (or the branch the task names), pushes it, and never merges; PRs need the maintainer's approval.

### P0 — Repo and spike (do first; blocks everything)

**P0.1 Scaffold.** The repo already exists with the PRD and this plan on branch `docs/prd-and-plan`.
- On that branch, run `paperclipai plugin init @coma-toast/paperclip-model-capacity --template default --display-name "Model capacity" --category automation`.
- Commit the scaffold, plus the PRD and this plan under `docs/`.
- Add `.github/workflows/ci.yml` running `npm ci && npm run typecheck && npm test && npm run build`.
- **Done when:** CI is green on the scaffold, and `npm run build` produces `dist/manifest.js`, `dist/worker.js` and `dist/ui/index.js`.

**P0.2 Spike: confirm the four host behaviors the design rests on.** The script goes in `scripts/spike/`, and findings go in `docs/spike-2026-10.md`. Run it against a throwaway project in a test company, with the plugin installed from a local path.
1. Adding a blocker via `relations.addBlockers` to a `todo` task, then commenting as an agent (not a human), creates no run. A human comment does create one.
2. `removeBlockers` + `requestWakeup` starts a run and returns `{queued, runId}`.
3. `ctx.issues.update(id, {assigneeAdapterOverrides: {adapterConfig: {model: 'x'}}})` persists (read it back). Record whether it's rejected.
4. `database.coreReadTables: ['heartbeat_runs','issues','agents']` lets `ctx.db.query` read running runs. Record the exact capability and manifest fields needed.
- **Done when:** the doc gives a yes or no for each item with evidence (API responses, run ids), and the plan's fallbacks are marked as needed or not.

### P1 — Pools, probes, gating, UI, alerts (observe → enforce)

**P1.1 Types and constants: `src/types.ts`, `src/constants.ts`.**
- `PoolConfig {id, name, patterns: string[], limit, privacy, mode, scope: 'instance'|'company', companies?: {include?, exclude?}, hosts: HostConfig[], overflow?: OverflowConfig, alertAfterMinutes}`
- `HostConfig {id, name, engine: EngineKind, baseUrl, declaredSlots, authSecretPath?}`
- `type EngineKind = 'llamacpp'|'ollama'|'openai'|'vllm'|'lmstudio'`
- `HostStatus`, `HeldTask`, `RunningRun`, `Snapshot`, `Action` (discriminated union), `AlertEvent`
- Constants: probe interval 30 s, probe timeout 5 s, down after 3 fails, up after 2 successes, sweep cron `* * * * *`, wake-confirm 30 s, retention 30 days, `STATE_SCHEMA_VERSION = 1`.
- **Done when:** `npm run typecheck` passes.

**P1.2 Pattern matching: `src/scheduler/match.ts`.**
- `matchPool(model, pools)` returns the most specific pool (PRD A2): an exact match beats a glob, then the longest literal text, then pool order.
- Glob supports `*` and `?` only.
- **Done when:** the table tests in `tests/match.spec.ts` cover exact vs glob, the longest-literal tiebreak, no match → `undefined`, and `opencode/*-free` vs `opencode/nemotron-*-free`.

**P1.3 Effective model: `src/scheduler/model.ts`.**
- `effectiveModel(issue, agent)`: the override wins only when `issue.assigneeAgentId === agent.id` (mirrors `heartbeat.js:1399-1401`).
- `isPinned(issue, pluginState)`: an override the plugin didn't set (PRD D4).
- **Done when:** `tests/model.spec.ts` covers no override, an override for the same agent, an override for a different agent (ignored), and a plugin-set vs human-set override.

**P1.4 Scheduler core: `src/scheduler/decide.ts`.** `decide(snapshot, now): Action[]`, pure.
- **Available capacity** per pool (B3): min(limit, sum over up hosts of (probed slots ?? declared) − outside busy), floored at 0. Outside busy = probed busy − Paperclip runs on that host, floored at 0 (PRD Q5).
- **Count** = running runs + released-not-started (B2).
- **Hold:** when count ≥ available, every open (`todo`/`in_progress`/`blocked`/`in_review`), non-exempt task in the pool without an active run gets a `hold` action (C1). Exempt tasks still count (B5).
- **Release:** when count < available and the pool isn't on hold, release held tasks in order: priority, then oldest hold (C2), up to the free slots.
- No pool up → no releases (E3).
- Over-limit runs produce an `alert` (B4) and no releases.
- **P2 hook:** an `overflow` branch that returns nothing until P2.
- **Done when:** `tests/decide.spec.ts` covers limits 0, 1 and 3; priority ordering; ties; exempt task and agent; host down; outside load; observe vs enforce (the scheduler always decides, the executor skips); a 3-task queue releasing high → medium → low (PRD AC2). Keep the spec under 400 lines with fixtures in `tests/fixtures/`.

**P1.5 State store: `src/state/store.ts`.**
- Typed get/set over `ctx.state`, holding:
  - instance scope `pools` (config), `hosts` (status), `holds` (issueId → {poolId, companyId, heldAt, position}), `released` (issueId → {runId, at}), `history` (capped ring per day key);
  - company scope `queueBlockers` (poolId → issueId).
- Version every blob and migrate on read (Aperture pattern).
- `ctx.state` has no list, so keep an index blob per kind.
- **Done when:** `tests/store.spec.ts` round-trips via `createTestHarness` and runs the version migration.

**P1.6 Snapshot builder: `src/snapshot.ts`.**
- Reads running and queued runs from `heartbeat_runs` (per P0.2), open issues per company via `ctx.issues.list({status})` (paged, limit 200), agents (cached 60 s), host status, holds and released from state.
- Fallback if the P0.2 database read is unavailable: `Issue.activeRun`.
- **Done when:** a harness test seeds 2 companies, 5 agents, 12 issues and 3 runs, and asserts the snapshot counts per pool.

**P1.7 Executor: `src/executor.ts`.**
- **`hold`:**
  - ensure the pool's queue blocker exists in the company (create once: `ctx.issues.create({title: '<pool> queue', status: 'todo', originKind: 'plugin'})`, unassigned);
  - `relations.addBlockers(issueId, [blockerId])`;
  - add the configured label if set (preserve existing `labelIds`);
  - post one comment ("Waiting for <pool> (position N). Model capacity plugin.") only on the first hold.
- **`release`:** `removeBlockers` + remove the label + `requestWakeup` → store `{runId}` in `released`. If no run within 30 s, retry the wake once on the next tick.
- **Recreate** the blocker if it was deleted, or closed `done` (C1a).
- **Observe mode:** no writes; append the decision to history only.
- **Manual changes win (C5):** if a human removed our blocker, drop the hold and log it.
- **Done when:** harness tests prove hold, release, observe-no-write, blocker recreation and a human-removed blocker. Nothing ever closes the queue blocker `done`, because that would wake every dependent.

**P1.8 Probes: `src/probes/{llamacpp,ollama,openai,vllm,lmstudio}.ts`, `src/probes/index.ts`.**
- **llama.cpp:** `GET /health` (200 = up); `GET /slots` gives slot count and `is_processing` for busy.
- **Ollama:** `GET /api/tags` (up); `GET /api/ps` (loaded models). No slot data, so use the declared slots (PRD Q4).
- **OpenAI-compatible:** `GET /v1/models` (up only).
- **vLLM:** `GET /metrics`, parsing `vllm:num_requests_running` and `num_requests_waiting`.
- **LM Studio:** `GET /api/v0/models` (up, loaded state).
- Hysteresis: down after 3 failures, up after 2 successes (E2). 5 s timeout. Optional auth header from a secret ref.
- **Done when:** `tests/probes.spec.ts` runs each adapter against a fake `node:http` server in `tests/fakes/` (one per engine), plus hysteresis, timeout and malformed JSON.

**P1.9 Worker wiring: `src/worker.ts`, `src/manifest.ts`.**
- **Capabilities:** `events.subscribe`, `jobs.schedule`, `plugin.state.read/write`, `issues.read`, `issues.create`, `issues.update`, `issues.wakeup`, `issue.relations.read/write`, `issue.comments.create`, `agents.read`, `companies.read`, `activity.log.write`, `http.outbound`, `secrets.read-ref`, the database read capability from P0.2, `ui.page.register`, `ui.dashboardWidget.register`, `instance.settings.register`.
- **Jobs:** `sweep` (`* * * * *`) and `prune` (`0 4 * * *`).
- **Events:** `agent.run.finished|failed|cancelled` → debounced (2 s) decide-and-execute for the run's company and pools; `agent.run.started` → refresh counts; `issue.updated` (`blockedBy` or status changes) → C5 handling; `agent.updated` → drop the agent cache.
- **Probe loop:** `setInterval` in setup, cleared in `onShutdown`.
- Add `onHealth` and `onValidateConfig`.
- **Done when:** a harness test emits `agent.run.finished` and sees a release within one debounce, and `runJob('sweep')` rebuilds holds from state after a simulated restart (PRD AC9 part 1).

**P1.10 Alerts: `src/alerts.ts`.**
- Dedupe per (kind, subject): fire once on start and once on clear (G3).
- Sinks: plugin state for the UI list; a comment on the company's configured standing task (only if that task has no assignee, warn otherwise, PRD G2); `ctx.activity.log`.
- Kinds in P1: host down/up, waited past `alertAfterMinutes`, over-limit run, plugin error.
- **Done when:** a harness test shows one comment per start and clear, no duplicates across sweeps, and no secrets in the text.

**P1.11 UI: `src/ui/index.tsx`, `src/ui/DashboardWidget.tsx`, `src/ui/CapacityPage.tsx`, `src/ui/SettingsPage.tsx`, `src/ui/components/*`.**
- **Worker data handlers:** `capacity-summary`, `queue`, `history`, `alerts`, `pools-config`.
- **Actions** (board only; check `actor.type === 'user'` and board access, A6): `save-pools`, `release-now`, `hold-pool`, `resume-pool`, `set-limit`, `exempt`, `move-to-front`.
- **Widget (H1):** a row per pool showing in-use/limit, queue length, oldest wait, host dots and an alert badge, with an "observe" chip (H5). Polls every 15 s like Aperture.
- **Page (H2):** pools and hosts, the queue table with positions and controls, history and alerts.
- **Settings (H4):** pool editor (patterns, limit, privacy, mode, scope, hosts with engine and URL, slots), probe interval, retention, label picker (existing labels), alert task id, webhook URL (used in P2). Secret refs use the host's `format:"secret-ref"` fields in company config.
- Use the SDK UI components (`MetricCard`, `StatusBadge`, `DataTable`).
- Validation (A7) runs in the `save-pools` action and returns field errors.
- **Done when:** `npm run build` passes; a harness test on `save-pools` covers privacy validation (PRD AC5 part 1), overlapping names and a negative limit; and screenshots of the widget and page from the live install are attached to the task.

**P1.12 Live rollout on the host (observe → enforce).**
1. `paperclipai plugin install <repo path> --local` (needs board access; the operator runs it or approves).
2. Configure pools from the PRD's I2 example, all in **observe**, and run for 24 h.
3. The operator reviews the would-hold log and approves enforce on `gpu` (limit 1).
4. Retire any routine or script that did the same job (PRD I3).
5. After 24 h clean, enforce `free` and `direct-free`.
- **Done when:** PRD AC1, AC2, AC6 (host-down drill: the operator stops the gpu model server), AC8 and AC9 have evidence comments.

### P2 — Overflow, task detail tab, webhook

**P2.1 Override writer: `src/overrides.ts`.**
- `setOverride(issue, model)` and `restoreOverride(issue)`.
- Path chosen by the P0.2 result: SDK `ctx.issues.update` with a cast and read-back verification; otherwise REST `PATCH {paperclipApiUrl}/api/issues/:id` with a bearer from the company config secret ref `boardApiToken`.
- Store the original override (or `null`) in issue-scope state before writing (D2). Retry restore on the next sweep, and alert after 3 failures (D5).
- **Done when:** harness tests cover the SDK path, the REST path (fetch stub), restoring the exact original and the retry/alert path.

**P2.2 Overflow decisions in `decide.ts`.**
- Triggers: waited > `overflowAfterMinutes`, home pool has no up host, `overflowImmediately` with a free target (D1).
- The first pool in the overflow list with capacity and privacy allowed. **Private → shared is never allowed** (A10): enforce it in `decide` and in settings validation.
- Pinned tasks never overflow (D4).
- On run end for an overflowed task → `restore` action (D3).
- **Done when:** `tests/overflow.spec.ts` covers each trigger, privacy refusal (PRD AC5 part 2), pin refusal (AC4) and the revert after finish, fail and cancel (AC3).

**P2.3 Task detail tab: `src/ui/TaskTab.tsx`.**
- Slot `detailTab` with `entityTypes: ['issue']`, capability `ui.detailTab.register`.
- Shows the pool, effective model, whether it's pinned, queue position, and hold, overflow and restore history (H3).
- **Done when:** the build passes and a screenshot from the live host is attached.

**P2.4 Webhook sink in `src/alerts.ts`.**
- POST JSON `{kind, state: 'start'|'clear', poolId, hostId?, issueIdentifier?, counts, at}` (N6: no content, no secrets). 5 s timeout, no retry storm (max 1 retry).
- **Done when:** a harness test with a fetch stub checks the payload shape.

**P2.5 Live:** enable overflow `gpu` → `free` after 15 minutes for unpinned tasks.
- **Done when:** AC3 and AC4 have evidence on the host.

### P3 — Quota sources, quota UI, Prometheus

**P3.1 Quota adapters: `src/quota/{litellm,openrouter,paperclip,headers}.ts`.**
- **LiteLLM (read-only admin key from a secret ref):**
  - `GET /model/info` for pool members;
  - `GET /spend/logs/ui?status_filter=failure` over 1 h and 24 h, grouped by model, counting 429s;
  - deployment cooldown state if exposed.
- **OpenRouter:** `GET /api/v1/key` for `limit_remaining`, `usage_daily` and `is_free_tier`.
- **Paperclip:** failed runs in `heartbeat_runs` whose error matches `/rate.?limit|429|quota|credit|insufficient/i` over 1 h and 24 h, per effective model. Keep the pattern list in config so the out-of-credit text can be added when seen (PRD open Q1).
- **Header probes:** opt-in per provider, 15 min default, minimal request (`max_tokens: 1`, fixed prompt "ping"); read the `x-ratelimit-*` headers (E4, E7).
- Each sample is `{source, value, resetAt?, sampledAt}` (E6).
- **Done when:** each adapter has a fake-server test, using recorded response shapes with all values replaced by fakes.

**P3.2 Quota → scheduling (E5).** An exhausted shared pool is treated as having 0 available until `resetAt` or a fresh non-exhausted sample.
- **Done when:** `tests/decide.spec.ts` has an exhausted-pool case that releases nothing and overflows per P2 rules.

**P3.3 Quota UI.** Add quota columns to the widget, history charts on the page (`TimeseriesChart`), and the source plus sample time for every number.
- **Done when:** a live screenshot matches OpenRouter's and LiteLLM's numbers at the same minute (PRD AC7).

**P3.4 Prometheus (deferred G4).** Expose `/metrics` through a plugin API route (`apiRoutes`, `api.routes.register`) with a bearer token setting.
- Gauges per pool: limit, available, running, held, oldest wait seconds; per host: up and slots. Counters: over-limit and overflows.
- **Done when:** `curl` with the token returns valid Prometheus text, and a sample Prometheus scrape config is documented in the README.

**P3.5 npm publish** (after P1 works on a real host): `npm publish --access public` as `@coma-toast/paperclip-model-capacity`. The maintainer runs it with their npm credentials.

## Testing strategy

- **Unit tests (vitest):** pure modules (`match`, `model`, `decide`, probes, quota parsers) with table tests. Fixtures live in `tests/fixtures/`.
- **Harness tests:** `createTestHarness` from `@paperclipai/plugin-sdk/testing` drives the executor, worker wiring, actions, data handlers and alerts. Stub `globalThis.fetch` for every outbound call. Secrets resolve to `resolved:<ref>`, so assert the ref path only.
- **Fake servers:** `tests/fakes/{llamacpp,ollama,openai,vllm,lmstudio,litellm,openrouter}.ts` use `node:http` on random ports and are configurable per test (up, down, slow, malformed).
- **Live smoke per phase** on a real Paperclip instance in observe mode first, with evidence posted on the phase task.
- **CI:** typecheck, test and build on every PR. No live calls in CI.

PRD acceptance criteria → tests:

| AC | Covered by |
|---|---|
| AC1 gpu never over 1 | P1.4 decide tests + P1.12 24 h live log |
| AC2 queue order | P1.4 (`high → medium → low`) + P1.12 live |
| AC3 overflow + revert | P2.2 tests + P2.5 live |
| AC4 pin respected | P2.2 tests + P2.5 live |
| AC5 privacy | P1.11 save validation + P2.2 decide refusal |
| AC6 host-down drill | P1.8 hysteresis tests + P1.12 live drill |
| AC7 quota accuracy | P3.1 fakes + P3.3 live comparison |
| AC8 observe mode | P1.7 observe-no-write + P1.12 live 24 h |
| AC9 restart | P1.9 sweep-after-restart test + P1.12 live restart |
| AC10 no LLM calls | P3.1 header probes off by default; a test asserts no outbound requests to model endpoints except configured probes |

## Risks and open questions

1. **Spike-dependent paths (P0.2).** If `addBlockers` doesn't stop agent-comment wakes the way the code suggests, or `requestWakeup` behaves differently, C1/C3 need status-based holds as well. Fallback: also set status `blocked`.
2. **Human comment wakes bypass gating by design.** On a busy day, over-limit events will show up. They're counted and alerted (B4), not prevented.
3. **The queue blocker is an issue that must never become `done`.** Closing it wakes every dependent at once, defeating the queue. Mitigations:
   - the title says "do not close";
   - the plugin reopens it if closed and alerts;
   - release always removes the blocker from one task at a time.
4. **Board token scope (REST fallback):** board keys carry full user access. Prefer the SDK path. If REST is needed, document the risk and recommend a dedicated board user with access to only the companies the plugin manages.
5. **`heartbeat_runs` access** depends on `database.coreReadTables` allowing it (P0.2). Fallback: `Issue.activeRun` plus events, accepting some drift.
6. **Weaker builder models.** If the building agents run small or free models, they may report work as done when it isn't. Every task needs command-output evidence in its done comment, and a reviewer spot-checks pushed branches before marking done.
7. **Per-company blockers for instance-wide pools.** Blockers are company issues, so an instance-wide pool has one blocker per company and releases across companies by global order. Verify in P1.4 tests that ordering spans companies.
8. **Out-of-credit pattern:** still unknown (PRD open Q1). It's a config list, so it can be added without a release.
