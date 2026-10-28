import type { Routes } from "./server.js";

export const openAiRoutes = (): Routes => ({ "/v1/models": { body: { object: "list", data: [{ id: "gpu" }] } } });
