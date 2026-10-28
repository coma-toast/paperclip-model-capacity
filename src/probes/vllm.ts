import { ProbeError, getText, type ProbeContext, type ProbeResult } from "./http.js";

// Sums a Prometheus gauge across its label sets, e.g. `vllm:num_requests_running{model_name="x"} 2.0`.
export const sumGauge = (text: string, name: string): number | undefined => {
  let total: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/);
    if (!m || m[1] !== name) continue;
    const value = Number(m[3]);
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
};

// vLLM has no fixed slot count; running requests are its busy slots and the pool uses declared slots as the total.
export const probeVllm = async (pc: ProbeContext): Promise<ProbeResult> => {
  const text = await getText(pc, "/metrics");
  const running = sumGauge(text, "vllm:num_requests_running");
  if (running === undefined) throw new ProbeError("/metrics has no vllm:num_requests_running");
  return { up: true, slotsBusy: Math.round(running) };
};
