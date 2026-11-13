# paperclip-model-capacity

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that keeps agents from overloading the models they run on.

- **Backends:** each model endpoint is set up once per company under Company settings → Model capacity: a proxy (LiteLLM or any OpenAI-compatible endpoint), a cloud API (OpenCode Zen, OpenRouter), or a local engine (Ollama, LM Studio, oMLX, vLLM, llama.cpp). The Add backend form asks for the type, address, API key and model-name prefix, tests the connection, and stores the key as a Paperclip company secret in the same step.
- **Pools:** a pool picks one backend, ticks the exact models it covers from the backend's model list, and caps how many agent runs it serves at once. A proxy's pool can also watch the local engines the proxy routes to. This is useful for local servers with one or two inference slots, and for free cloud tiers.
- **Queue:** when a pool is full, waiting tasks are held with a native Paperclip blocker and released by priority, then oldest first, as slots free up.
- **Overflow:** waiting work can move to another allowed pool. Private work never moves to a third-party model.
- **Health and quota:** probes llama.cpp, Ollama, vLLM, LM Studio and OpenAI-compatible servers, and tracks free-tier quota (LiteLLM, OpenRouter).
- **Visibility:** a dashboard widget, a capacity page, a task tab and alerts. Every pool starts in observe-only mode.

Status: in design. See [docs/prd-paperclip-model-capacity.md](docs/prd-paperclip-model-capacity.md) and [docs/plan-paperclip-model-capacity.md](docs/plan-paperclip-model-capacity.md).

## Prometheus metrics

The plugin exposes Prometheus metrics via a scoped plugin API route at `/api/plugins/coma-toast.model-capacity/api/metrics`.

### Authentication

The endpoint requires authentication:
- By default, requests are authorized using a valid Paperclip bearer token (`Authorization: Bearer <paperclip-token>`), such as a board API key or agent token.
- Optionally, configure `metricsToken` under the plugin instance settings (`Paperclip Settings → Plugins → Model capacity`). When set, scrapers must present this bearer token in the `Authorization: Bearer <token>` header or pass `?token=<metricsToken>`.

### Scrape configuration

Add a job to your Prometheus configuration (`prometheus.yml`):

```yaml
scrape_configs:
  - job_name: "paperclip-model-capacity"
    metrics_path: "/api/plugins/coma-toast.model-capacity/api/metrics"
    params:
      companyId: ["<your-company-id>"]
    bearer_token: "<your-paperclip-or-metrics-token>"
    static_configs:
      - targets: ["paperclip.example.ts.net:3110"]
```

### Metrics

| Metric | Type | Description |
|---|---|---|
| `paperclip_model_capacity_pool_limit` | Gauge | Configured run limit for the model pool |
| `paperclip_model_capacity_pool_available` | Gauge | Available capacity slots in the model pool |
| `paperclip_model_capacity_pool_running` | Gauge | Number of runs occupying capacity in the model pool |
| `paperclip_model_capacity_pool_held` | Gauge | Number of tasks queued in the model pool |
| `paperclip_model_capacity_pool_oldest_wait_seconds` | Gauge | Wait time in seconds of the oldest queued task in the pool |
| `paperclip_model_capacity_host_up` | Gauge | Whether the host/engine is reachable (1) or down (0) |
| `paperclip_model_capacity_host_slots_total` | Gauge | Total capacity slots on the host (when reported) |
| `paperclip_model_capacity_host_slots_busy` | Gauge | Busy capacity slots on the host (when reported) |
| `paperclip_model_capacity_quota_remaining` | Gauge | Remaining quota for an upstream provider or backend meter |
| `paperclip_model_capacity_over_limit_total` | Counter | Total over-limit events observed for the pool |
| `paperclip_model_capacity_overflow_total` | Counter | Total overflow events observed for the pool |

License: MIT.
