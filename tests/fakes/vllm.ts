import type { Routes } from "./server.js";

export const vllmRoutes = (running: number[]): Routes => ({
  "/metrics": {
    text: [
      "# HELP vllm:num_requests_running Number of requests currently running.",
      "# TYPE vllm:num_requests_running gauge",
      ...running.map((n, i) => `vllm:num_requests_running{model_name="m${i}"} ${n}.0`),
      'vllm:num_requests_waiting{model_name="m0"} 4.0',
    ].join("\n"),
  },
});
