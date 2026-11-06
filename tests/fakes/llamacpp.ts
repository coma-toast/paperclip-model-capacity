import type { Routes } from "./server.js";

export const llamaCppRoutes = (busy: boolean[]): Routes => ({
  "/health": { body: { status: "ok" } },
  "/slots": { body: busy.map((is_processing, id) => ({ id, is_processing })) },
});
