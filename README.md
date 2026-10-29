# paperclip-model-capacity

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that keeps agents from overloading the models they run on.

- **Backends:** each model endpoint is set up once per company under Company settings → Model capacity: a proxy (LiteLLM or any OpenAI-compatible endpoint), a cloud API (OpenCode Zen, OpenRouter), or a local engine (Ollama, LM Studio, oMLX, vLLM, llama.cpp). The Add backend form asks for the type, address, API key and model-name prefix, tests the connection, and stores the key as a Paperclip company secret in the same step.
- **Pools:** a pool picks one backend, ticks the exact models it covers from the backend's model list, and caps how many agent runs it serves at once. A proxy's pool can also watch the local engines the proxy routes to. This is useful for local servers with one or two inference slots, and for free cloud tiers.
- **Queue:** when a pool is full, waiting tasks are held with a native Paperclip blocker and released by priority, then oldest first, as slots free up.
- **Overflow:** waiting work can move to another allowed pool. Private work never moves to a third-party model.
- **Health and quota:** probes llama.cpp, Ollama, vLLM, LM Studio and OpenAI-compatible servers, and tracks free-tier quota (LiteLLM, OpenRouter).
- **Visibility:** a dashboard widget, a capacity page, a task tab and alerts. Every pool starts in observe-only mode.

Status: in design. See [docs/prd-paperclip-model-capacity.md](docs/prd-paperclip-model-capacity.md) and [docs/plan-paperclip-model-capacity.md](docs/plan-paperclip-model-capacity.md).

License: MIT.
