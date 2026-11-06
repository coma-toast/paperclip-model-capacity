# paperclip-model-capacity

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that keeps agents from overloading the models they run on.

- **Pools:** group models by glob pattern (for example `litellm/vm` or `opencode/*-free`) and cap how many agent runs each pool serves at once. This is useful for local hosts with one or two inference slots, and for free cloud tiers.
- **Queue:** when a pool is full, waiting tasks are held with a native Paperclip blocker and released by priority, then oldest first, as slots free up.
- **Overflow:** waiting work can move to another allowed pool. Private work never moves to a third-party model.
- **Health and quota:** probes llama.cpp, Ollama, vLLM, LM Studio and OpenAI-compatible servers, and tracks free-tier quota (LiteLLM, OpenRouter).
- **Visibility:** a dashboard widget, a capacity page, a task tab and alerts. Every pool starts in observe-only mode.

Status: in design. See [docs/prd-paperclip-model-capacity.md](docs/prd-paperclip-model-capacity.md) and [docs/plan-paperclip-model-capacity.md](docs/plan-paperclip-model-capacity.md).

License: MIT.
