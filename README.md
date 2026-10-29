# paperclip-model-capacity

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that keeps agents from overloading the models they run on.

- **Pools:** each pool covers one model API: a proxy (LiteLLM or any OpenAI-compatible endpoint), a cloud API (OpenCode Zen, OpenRouter), or a local engine (Ollama, LM Studio, oMLX, vLLM, llama.cpp). It groups that API's models by name or glob (for example `openrouter/*:free` or `ollama/qwen3:*`) and caps how many agent runs it serves at once. This is useful for local servers with one or two inference slots, and for free cloud tiers. Pools are set per company under Company settings → Model capacity.
- **Endpoints and credentials:** a pool can list its API's models (Load models), and local engines are health-checked at their own address. Keys live in the plugin's company config as Credential 1–4 (stored as Paperclip secrets) and are referred to by name.
- **Queue:** when a pool is full, waiting tasks are held with a native Paperclip blocker and released by priority, then oldest first, as slots free up.
- **Overflow:** waiting work can move to another allowed pool. Private work never moves to a third-party model.
- **Health and quota:** probes llama.cpp, Ollama, vLLM, LM Studio and OpenAI-compatible servers, and tracks free-tier quota (LiteLLM, OpenRouter).
- **Visibility:** a dashboard widget, a capacity page, a task tab and alerts. Every pool starts in observe-only mode.

Status: in design. See [docs/prd-paperclip-model-capacity.md](docs/prd-paperclip-model-capacity.md) and [docs/plan-paperclip-model-capacity.md](docs/plan-paperclip-model-capacity.md).

License: MIT.
