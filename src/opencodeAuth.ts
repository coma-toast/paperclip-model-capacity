import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// GitHub Copilot with no saved key: the GitHub token from opencode's Copilot login on this host (`opencode auth
// login`), which agents use too, so the subscription is set up once. Paperclip copies it into each agent's home.
export const OPENCODE_AUTH_PATH = () => join(homedir(), ".local", "share", "opencode", "auth.json");
export const opencodeCopilotToken = async (path = OPENCODE_AUTH_PATH()): Promise<string | undefined> => {
  const auth = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Record<string, { refresh?: unknown } | undefined>;
  const token = auth["github-copilot"]?.refresh;
  return typeof token === "string" && token ? token : undefined;
};
