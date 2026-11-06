# PRD: paperclip-model-capacity — capacity, queueing and quota for local and free LLMs

- **Date:** 2026-10-27
- **Status:** Draft (revised 2026-10-27 after Q&A)
- **Repo:** `coma-toast/paperclip-model-capacity` (MIT, public)

## Problem statement

Paperclip agents start runs whenever they are woken, with no idea how many runs the underlying model can serve. Local models usually serve one request at a time, or a few, so extra runs pile onto the same GPU, slow everything down or fail. Free cloud models have rate and credit limits that run out without warning. Operators have no single place to see capacity, queue depth or remaining quota. A common workaround is an LLM routine that polls every few minutes, which spends hundreds of model calls a day just to count tasks.

This affects anyone running Paperclip agents on their own hardware or on free tiers, for example a setup with two local hosts (a GPU box running llama.cpp with one slot, and a laptop running Ollama) plus a LiteLLM pool of free cloud models.

## Goals

1. A host never runs more Paperclip agent runs than it can serve. For example, a single-slot GPU host runs at most 1 Paperclip run at a time.
2. Work that can't start waits in a visible, ordered queue instead of failing or overloading a host.
3. Waiting work can move to another allowed model (overflow) without ever moving private work to a third-party model.
4. Operators see, in one place, each pool's use, queue, host health and remaining free-tier quota, and get alerted when something runs out or goes down.
5. Do all of this deterministically: the plugin itself makes no LLM calls.
6. Generic: anyone can install it and describe their own hosts and pools. Nothing specific to one deployment is built in.

## Non-goals

- Limiting individual LLM requests. The unit is the agent run, because one run holds a model for many back-to-back calls.
- Replacing a gateway's own routing or fallbacks (LiteLLM's `free` → `gpu` fallback stays as it is).
- Cancelling runs or changing an agent's own model. The plugin changes tasks only.
- Billing or dollar budgets (Paperclip's budget policies cover billed cents).
- Starting, stopping or reconfiguring model servers.
- Supporting Paperclip versions older than 2026.1026.0-nightly.

## Definitions

- **Pool:** a named capacity group. It has model patterns, one or more hosts or a quota source, a limit, a privacy level and overflow settings.
- **Effective model of a task:** the task's `assigneeAdapterOverrides.adapterConfig.model` if set, otherwise the assigned agent's `adapterConfig.model`.
- **Plugin override:** a task model override that this plugin set. Any other override is a **pin**.
- **Queue blocker:** one standing task per pool (and per company when the pool is per-company), titled `<pool> queue`, created and owned by the plugin, never assigned and never closed while the pool exists.
- **Held task:** a task whose `blockedByIssueIds` includes its pool's queue blocker and that carries the label `queue:<pool>`.
- **Mode:** `observe` (decide and log, change nothing) or `enforce` (change tasks). Set per pool.

## Functional requirements

### A. Pools and configuration

- **A1 MUST:** The operator defines pools in a settings page in the Paperclip UI. Each pool has a name, a list of model glob patterns, a max-concurrent-runs limit, a privacy level (`private` or `shared`), a mode (`observe` or `enforce`), and optionally hosts, an overflow list and quota sources.
- **A2 MUST:** A task belongs to the pool whose pattern matches its effective model **most specifically**: an exact match beats any glob, then the pattern with the longest literal (non-wildcard) text wins, and pool order breaks any remaining tie. A task that matches no pool is never limited.
- **A3 MUST:** Each pool has a scope: instance-wide (one shared limit for every company) or per-company (each company gets its own limit). It also has a company include/exclude list. The settings page sets both.
- **A4 MUST:** Config changes, including limit changes, take effect within 10 s with no restart.
- **A5 MUST:** Credentials for hosts, LiteLLM, OpenRouter, provider probes and the Paperclip board API token used for overflow (D2) are stored as Paperclip secret references. Values are never shown in the UI, logs, comments, webhooks or metrics.
- **A6 MUST:** Only board users can view or change settings or use the manual controls (section F).
- **A7 SHOULD:** Settings validation rejects unknown fields, overlapping pool names, overflow cycles that break privacy (A10), and limits below 0, with a message naming the field.
- **A8 MUST:** The overflow list for a pool is an ordered list of other pools.
- **A9 MUST:** Every setting has a safe default. A new install starts every pool in `observe` mode.
- **A10 MUST (added during refinement):** Overflow from a `private` pool to a `shared` pool is never allowed. Settings validation rejects it, and the scheduler refuses it even if it were configured.

### B. Capacity

- **B1 MUST:** A pool's limit is a whole number of concurrent agent runs, counted across the pool's scope (A3).
- **B2 MUST:** Running count = agent runs currently `running` (and runs the plugin released that haven't started yet) whose task's effective model is in the pool. Released-but-not-started runs count, so two releases can't race past the limit.
- **B3 MUST:** For a pool with hosts, available capacity = min(declared limit, sum over **up** hosts of probed slots − slots busy from outside Paperclip), never below 0. A host with no probe contributes its declared per-host slots.
- **B4 MUST:** A run started outside the plugin (e.g. a comment woke an agent while its pool was full) is allowed to run and counts toward the limit. Nothing new is released until the pool is back under the limit, and the event is logged as over-limit.
- **B5 MUST:** An agent's or task's exemption (F4) means its runs never wait, but they still count toward the limit.

### C. Queue

- **C1 MUST:** In `enforce` mode, when a task in a pool is about to be woken (`issue.assignment_wakeup_requested`, which fires before the run starts) while the pool is full, the plugin holds it: adds the pool's queue blocker to its `blockedByIssueIds`, adds the label `queue:<pool>`, and posts one comment saying which pool it waits for and its position. It posts at most one comment per hold, not one per position change.
- **C1a MUST:** The plugin creates each pool's queue blocker on first use, recreates it if someone deletes or closes it, and re-points held tasks to the new one.
- **C2 MUST:** Queue order is task priority (critical > high > medium > low), then time held (oldest first).
- **C3 MUST:** When capacity frees, the plugin releases the first held task: removes the queue blocker from its `blockedByIssueIds` and removes the label, so Paperclip's native "blockers resolved" wake starts it. If no run has started 30 s after release, the plugin calls `requestWakeup` once. Release happens within 10 s of the run that freed the slot finishing.
- **C4 MUST:** A sweep runs every minute and fixes anything events missed: releases due tasks, re-counts runs, and recovers the queue after a plugin restart from the queue blockers and `queue:<pool>` labels alone.
- **C5 MUST:** A held task where a person removes the queue blocker or the label is treated as manually released and leaves the queue. The plugin never fights a human change. Other blockers a task has are left alone.
- **C6 MUST:** In `observe` mode the plugin computes the same decisions, records them and shows them in the UI, but changes no task.
- **C7 SHOULD:** A task closed or cancelled while held leaves the queue with no further action.

### D. Overflow

- **D1 MUST:** A held task may overflow to the first pool in its overflow list that has free capacity and is allowed by privacy (A10). Overflow happens when any of the pool's enabled triggers fires:
  - (a) the task has waited longer than the pool's `overflowAfterMinutes`;
  - (b) the task's home pool has no up host;
  - (c) `overflowImmediately` is on and a target pool has a free slot right now.
- **D2 MUST:** Overflow sets the task's model override to the target pool's configured model, records the original override (or "none") in plugin state, releases the task, and comments once with from-pool, to-pool and reason. The plugin SDK's `issues.update` can't set `assigneeAdapterOverrides` (checked in SDK 2026.1026.0), so v1 sets it through Paperclip's REST API (`PATCH /api/issues/{id}`) with a board API token from a secret reference (A5). Without that token configured, overflow is off and the UI says why.
- **D2a SHOULD:** Open an upstream Paperclip PR adding `assigneeAdapterOverrides` to the plugin SDK's `issues.update`. When the host SDK supports it (detected at startup), the plugin uses the SDK and no longer needs the board token.
- **D3 MUST:** When the overflowed task's run ends (finished, failed or cancelled), the plugin restores the original override exactly (or removes its own) and comments once.
- **D4 MUST:** Tasks with a pin (an override the plugin didn't set) never overflow. They only queue.
- **D5 MUST:** If restoring an override fails, the plugin retries on the next sweep and raises an alert after 3 failures.

### E. Hosts, probes and quota

- **E1 MUST:** Host probes, every 30 s by default (configurable):
  - llama.cpp server: `/health`, plus `/slots` for total and busy slots;
  - Ollama: reachability, running models, and parallel slots when exposed;
  - OpenAI-compatible: `/v1/models` reachability only, covering LM Studio, vLLM, oMLX and LiteLLM;
  - vLLM and LM Studio: their own status or metrics endpoints for running and waiting requests.
- **E2 MUST:** A host is **down** after 3 failed probes in a row and **up** after 2 successes in a row. Up/down changes are recorded and alerted (G1).
- **E3 MUST:** When a pool loses all its hosts, it releases nothing new (held tasks stay held unless they overflow per D1b), and the event is alerted. Runs already going on that host are not cancelled. When such a run fails or is marked lost, the plugin holds its task (C1) before the next wake. A retry that starts before the plugin sees the failure counts as B4.
- **E4 MUST:** Quota sources:
  - **LiteLLM:** per-deployment health from data it already has, 429/failure counts over 1 h and 24 h, and remaining-request values it records. Read-only, admin key by secret ref.
  - **OpenRouter:** credit left and free requests used today, from `GET /api/v1/key`.
  - **Paperclip's own data:** failed runs whose error matches rate-limit, credit or quota patterns, per model, over 1 h and 24 h.
  - **Provider header probes:** opt-in per provider, every 15 min by default. A minimal request reads `x-ratelimit-*` headers.
- **E5 MUST:** When a shared pool's quota source reports it exhausted, the pool is treated as full until the reported reset time passes, or the next sample shows quota again. Held tasks queue or overflow as for a busy host.
- **E6 SHOULD:** Every quota number shown has its source and sample time, so stale numbers are visible as stale.
- **E7 MUST (added during refinement):** Probes never send task content, and they use the smallest request the provider accepts.

### F. Manual controls (board only)

- **F1 MUST:** **Release now** (bypass) starts one held task immediately, ignoring the limit once. It is logged with who did it.
- **F2 MUST:** **Hold pool** stops releasing new work to a pool until it is resumed. Runs already going are untouched.
- **F3 MUST:** **Change limit live** edits a pool's limit from the UI, applied within 10 s.
- **F4 MUST:** **Exempt** an agent or a task: it never waits (B5).
- **F5 SHOULD:** **Move to front** reorders one held task to position 1.

### G. Alerts and observability

- **G1 MUST:** Alert events:
  - host down or up;
  - quota exhausted or restored;
  - a task waited longer than `alertAfterMinutes` (per pool);
  - an over-limit run (B4);
  - an override restore failure (D5);
  - plugin errors.
- **G2 MUST:** Each alert goes to every configured channel:
  - the UI (widget and page);
  - one comment on a configured standing Paperclip task, which must wake nobody, so an unassigned task is recommended;
  - the Paperclip activity log;
  - an optional webhook (POST JSON);
  - Prometheus metrics.
- **G3 MUST:** Alerts are deduplicated. The same condition for the same pool, host or task alerts once when it starts and once when it clears.
- **G4 MUST:** Metrics, per pool:
  - limit, available capacity, running and held counts;
  - oldest wait in seconds;
  - host up (1/0) and slots total and busy per host;
  - quota remaining per source when known;
  - over-limit events and overflow count.
- **G5 MUST:** History of holds, releases, overflows, restores, quota samples and alerts is kept for a configurable number of days (default 30) and pruned daily.

### H. UI

- **H1 MUST:** **Dashboard widget**, one row per pool: in use / limit, queue length, oldest wait, host status, quota left, and an alert badge.
- **H2 MUST:** **Plugin page:**
  - pools and hosts, with live numbers;
  - the queue with positions and wait times;
  - recent overflows and restores;
  - quota history charts;
  - the alert list;
  - the manual controls (F).
- **H3 MUST:** **Task detail tab:** the task's pool, effective model and whether it's a pin, queue position, and hold, overflow and restore history.
- **H4 MUST:** **Settings page:** edit pools, patterns, hosts, limits, scope, overflow list and triggers, privacy, mode, quota sources, alert channels, probe intervals and retention, with validation (A7).
- **H5 SHOULD:** Observe-mode pools are visibly marked as observe-only everywhere they appear.

### I. Rollout and migration

- **I1 MUST:** Every pool starts in `observe` mode, and enforce is switched per pool (A9, C6).
- **I2 SHOULD:** The README gives a worked example of a typical small setup:
  - pool `gpu`: `gateway/gpu`, `gateway/gpu-*`; limit 1; private; llama.cpp probe.
  - pool `laptop`: Ollama probe; private.
  - pool `local`: hosts laptop + gpu, summed.
  - pool `free`: `gateway/free`, `gateway/free-*`; shared; LiteLLM + OpenRouter quota.
  - pool `direct-free`: `opencode/*-free`; shared.
- **I3 SHOULD (operator step, documented):** When a pool goes to enforce, retire any routine or script that was doing the same job, so the two don't fight.

## Non-functional requirements

- **N1:** No LLM calls by the plugin. Provider header probes (E4) are minimal requests and opt-in.
- **N2:** A freed slot is refilled within 10 s (event path). The sweep catches everything within 60 s.
- **N3:** Correctness: the plugin never releases a task that would put a pool over its limit (B2). Over-limit only happens through B4 or F1, and both are logged.
- **N4:** Restart safety: after a plugin or Paperclip restart, the queue, overflow overrides and counts are rebuilt from Paperclip task state plus plugin state, with no duplicate releases.
- **N5:** Load: handles 50 agents, 500 open tasks and 10 pools with each sweep finishing in under 2 s and under 1 req/s average to the Paperclip API.
- **N6:** Security: board-only settings and controls, secret refs only (A5). Webhook payloads hold pool, host and task identifiers and counts, never task content or secrets.
- **N7:** Compatibility: Paperclip ≥ 2026.1026.0-nightly. On older versions it refuses to enable with a clear message.
- **N8:** Tests run without any real model server: fake engines for llama.cpp, Ollama, OpenAI-compatible, vLLM and LM Studio, plus fake LiteLLM, OpenRouter and Paperclip APIs.

## User workflows

**Set up (operator)**
1. Install the plugin from the repo.
2. Open Settings → Model capacity and add pools, hosts and quota sources. Pick secrets from Paperclip secrets, including a board API token if you want overflow.
3. Leave everything in observe mode for a day; watch the widget and page for the queue it *would* build.
4. Switch `gpu` to enforce. Archive the old routine.

**Normal run (happy path)**
1. Agent A on `gateway/gpu` is woken while gpu runs 1 task. The plugin holds it: the `gpu queue` blocker is added, plus the label `queue:gpu` and a comment "waiting for gpu (1st in line)".
2. The running task's run finishes. Within 10 s the plugin removes A's queue blocker and label, and Paperclip's "blockers resolved" wake starts it.

**Overflow**
1. Task B (gpu, no pin) has waited past 15 min. `free` has a slot.
2. The plugin sets B's override to the `free` model, releases it, and comments.
3. B's run finishes. The plugin restores B's original override and comments.

**Pinned private task**
1. Task C is pinned to `gateway/gpu` by a person. gpu is full.
2. C queues only. It never overflows, even past the timeout.

**Host down**
1. The gpu probe fails 3 times. The plugin marks gpu down and alerts on every channel.
2. Runs already on gpu are left to fail. Each one's task is queued when its run ends. Held gpu tasks overflow (unpinned) or wait (pinned).
3. gpu answers twice. The plugin marks it up, alerts recovery, and releases in order.

**Quota exhausted**
1. The OpenRouter or LiteLLM source shows the free pool is out until 00:00 UTC.
2. The `free` pool is treated as full. Its work queues, or overflows to `gpu` if configured.
3. At reset the pool reopens and the alert clears.

**Manual**
1. A board user clicks Release now on a held incident task. It starts at once, logged as a bypass.

## Integration points

- **Paperclip plugin SDK** (`@paperclipai/plugin-sdk` 2026.1026.0):
  - events: `agent.run.started|finished|failed|cancelled`, `issue.updated`, `issue.assignment_wakeup_requested`;
  - jobs: 1-minute sweep, retention prune;
  - issues: read, update, wakeup, comments;
  - agents: read;
  - costs: read;
  - state, secrets (read-ref), http outbound, metrics, activity log;
  - UI slots: `dashboardWidget`, `page`, `detailTab`, `settingsPage`.
- **Paperclip task fields:** `status`, labels, `priority`, `assigneeAdapterOverrides.adapterConfig.model`.
- **Engines:** llama.cpp server, Ollama, OpenAI-compatible `/v1/models`, vLLM, LM Studio.
- **LiteLLM admin API** (read-only): model info, health data, spend/failure logs.
- **OpenRouter** `GET /api/v1/key`.
- **Outbound:** webhook (JSON), Prometheus metrics.

## Acceptance criteria

1. **gpu limit:** given `gpu` in enforce with limit 1, when a company runs a normal day of work, then no point in the day has more than 1 Paperclip run on gpu except logged B4/F1 events, and the plugin's own releases caused 0 over-limit events.
2. **Queue:** given gpu is full, when 3 tasks (priorities low, high, medium) are woken, then all 3 are held with `queue:gpu` and released in the order high, medium, low, each within 10 s of a slot freeing.
3. **Overflow and revert:** given an unpinned gpu task waits past `overflowAfterMinutes`, when `free` has a slot, then it runs on the free model and its original override is restored after the run, with one comment for each step.
4. **Pin respected:** given a task pinned to `gateway/gpu` by a person, when gpu stays full past the timeout, then it is never overflowed.
5. **Privacy:** given a private pool with a shared pool in its overflow list, when settings are saved, then validation rejects it. When the plugin evaluates overflow anyway, it never moves private work to the shared pool.
6. **Host-down drill:** given the model server is stopped on the gpu host, when 3 probes fail, then gpu shows down in the widget, an alert lands on every configured channel, no gpu task is released, and each gpu task whose run fails is held in the queue. After it restarts, recovery is alerted and the queue drains in order.
7. **Quota accuracy:** given the free pool with OpenRouter and LiteLLM sources, when compared with OpenRouter's key endpoint and LiteLLM's logs at the same moment, then the widget's credit-left and 429 counts match, each with a sample time.
8. **Observe mode:** given a pool in observe, when it is over its limit, then no task changes, and the UI shows the queue it would have built.
9. **Restart:** given 2 held tasks and 1 overflowed task, when Paperclip restarts, then after the next sweep the same 2 are still held in the same order and the overflowed task's original override is restored when its run ends. No task is released twice.
10. **No LLM calls:** given 24 h of operation with header probes off, then the plugin made 0 model requests.

## Open questions

1. **"Out of credit" error text (E4):** no example was found in data since 2026-10-23. Add the matching pattern when the next real one appears.
2. **Do open blockers stop a run from starting?** Paperclip has a native `issue_blockers_resolved` wake, which suggests runs wait on blockers. This needs confirming in a spike before C1/C3 are built. If a woken task with an open blocker still starts, C1 falls back to also setting status `blocked`.
3. **Board token scope for D2:** check the narrowest Paperclip credential that can PATCH `assigneeAdapterOverrides`, and whether an agent-scoped key would do.

### Resolved (2026-10-27)
- Plugin SDK `issues.update` can't set `assigneeAdapterOverrides`; overflow uses the REST API for now, with an upstream PR later (D2, D2a).
- `issue.assignment_wakeup_requested` fires before the run starts, so tasks are held before they run (C1).
- In-flight runs on a dead host are not cancelled; the task is queued once its run fails (E3).
- Ollama without exposed parallel slots uses the declared per-host slots (B3).
- Outside load = probed busy − Paperclip runs on that host, floored at 0 (B3).
- The most specific pattern wins (A2).
- Two companies' per-company pools on one host count each other as outside load (A3, B3).
- The queue uses one blocker task per pool plus a label (C1, C1a, C3).
