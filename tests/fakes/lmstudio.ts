import type { Routes } from "./server.js";

export const lmStudioRoutes = (states: string[]): Routes => ({
  "/api/v0/models": { body: { object: "list", data: states.map((state, i) => ({ id: `m${i}`, state })) } },
});
