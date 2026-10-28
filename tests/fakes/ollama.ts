import type { Routes } from "./server.js";

export const ollamaRoutes = (): Routes => ({
  "/api/tags": { body: { models: [{ name: "vaultbox/strata:fast" }] } },
  "/api/ps": { body: { models: [{ name: "vaultbox/strata:fast" }] } },
});
