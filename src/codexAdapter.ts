import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { Usage } from "./pricing";
import { CodexQuotaSnapshot, NormalizedTurn, ProviderAdapter, ProviderFileTask, ProviderMetaEvent } from "./providerAdapter";

interface CodexTurnContext {
  model: string;
  cwd: string;
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  defaultRoot() {
    return defaultCodexRoot();
  },
  async listSessionFiles(root: string): Promise<ProviderFileTask[]> {
    if (!fs.existsSync(root)) return [];

    const tasks: ProviderFileTask[] = [];
    const years = await safeDirNames(root);
    for (const year of years) {
      const yearDir = path.join(root, year);
      const months = await safeDirNames(yearDir);
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = await safeDirNames(monthDir);
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files: string[] = [];
          try {
            files = (await fs.promises.readdir(dayDir)).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue;
          }
          for (const file of files) {
            tasks.push({
              provider: "codex",
              full: path.join(dayDir, file),
              session: path.basename(file, ".jsonl"),
              rawDir: `${year}/${month}/${day}`,
              fallbackProject: "",
            });
          }
        }
      }
    }

    return tasks;
  },
  async processFile(
    task: ProviderFileTask,
    onTurn: (turn: NormalizedTurn) => void,
    onMeta?: (event: ProviderMetaEvent) => void,
  ): Promise<void> {
    const stream = fs.createReadStream(task.full, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let sessionCwd = "";
    let activeTurnId = "";
    let latestContext: CodexTurnContext = { model: "unknown", cwd: "" };
    const turnContexts = new Map<string, CodexTurnContext>();
    const turnsByKey = new Map<string, NormalizedTurn>();

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const type = typeof event?.type === "string" ? event.type : "";

        if (type === "session_meta") {
          sessionCwd = typeof event.payload?.cwd === "string" ? event.payload.cwd : sessionCwd;
          continue;
        }

        if (type === "turn_context") {
          const turnId = typeof event.payload?.turn_id === "string" ? event.payload.turn_id : "";
          const context: CodexTurnContext = {
            model: typeof event.payload?.model === "string" ? event.payload.model : "unknown",
            cwd: typeof event.payload?.cwd === "string" ? event.payload.cwd : sessionCwd,
          };
          latestContext = context;
          if (turnId) {
            activeTurnId = turnId;
            turnContexts.set(turnId, context);
          }
          continue;
        }

        if (type === "event_msg" && event.payload?.type === "task_started") {
          activeTurnId = typeof event.payload?.turn_id === "string" ? event.payload.turn_id : activeTurnId;
          if (activeTurnId && turnContexts.has(activeTurnId)) {
            latestContext = turnContexts.get(activeTurnId)!;
          }
          continue;
        }

        if (type === "event_msg" && event.payload?.type === "error") {
          if (event.payload?.codex_error_info === "usage_limit_exceeded" && onMeta) {
            onMeta({
              type: "codexLimitExceeded",
              timestamp: typeof event.timestamp === "string" ? event.timestamp : "",
              message: typeof event.payload?.message === "string" ? event.payload.message : "",
            });
          }
          continue;
        }

        if (type !== "event_msg" || event.payload?.type !== "token_count") continue;

        const quotaSnapshot = normalizeQuotaSnapshot(event);
        if (quotaSnapshot && onMeta) {
          onMeta({ type: "codexQuota", snapshot: quotaSnapshot });
        }

        const usage = normalizeCodexUsage(event.payload?.info);
        if (!usage) continue;

        const turnContext = activeTurnId && turnContexts.has(activeTurnId)
          ? turnContexts.get(activeTurnId)!
          : latestContext;
        const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
        const key = `${task.full}:${timestamp}`;

        turnsByKey.set(key, {
          provider: "codex",
          key,
          timestamp,
          day: localDayKey(timestamp),
          hour: localHourKey(timestamp),
          project: turnContext.cwd || sessionCwd || task.fallbackProject,
          model: turnContext.model || "unknown",
          usage,
          session: task.session,
          rawDir: task.rawDir,
        });
      } catch {}
    }

    for (const turn of turnsByKey.values()) onTurn(turn);
  },
};

export function defaultCodexRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

async function safeDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function normalizeCodexUsage(info: any): Usage | null {
  const usage = info?.last_token_usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = safeNum(usage.input_tokens);
  const cachedInputTokens = safeNum(usage.cached_input_tokens);
  const outputTokens = safeNum(usage.output_tokens);
  const reasoningOutputTokens = safeNum(usage.reasoning_output_tokens);
  return {
    // OpenAI/Codex reports cached_input_tokens as a subset of input_tokens.
    // Keep Usage semantics aligned with Claude pricing: input_tokens here means
    // billable non-cached input, and cache_read_input_tokens is the cached slice.
    input_tokens: Math.max(0, inputTokens - cachedInputTokens),
    cache_read_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
  };
}

function normalizeQuotaSnapshot(event: any): CodexQuotaSnapshot | null {
  const primary = event?.payload?.rate_limits?.primary;
  if (!primary || typeof primary !== "object") return null;
  const usedPercent = safeNum(primary.used_percent);
  const windowMinutes = safeNum(primary.window_minutes);
  const resetsAt = safeNum(primary.resets_at);
  if (windowMinutes <= 0 || resetsAt <= 0) return null;
  return {
    provider: "codex",
    timestamp: typeof event?.timestamp === "string" ? event.timestamp : "",
    usedPercent,
    windowMinutes,
    resetsAt,
    planType: typeof event?.payload?.rate_limits?.plan_type === "string" ? event.payload.rate_limits.plan_type : "unknown",
    lastTurnTokens: safeNum(event?.payload?.info?.last_token_usage?.total_tokens),
  };
}

function safeNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function localDayKey(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localHourKey(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${localDayKey(ts)} ${String(d.getHours()).padStart(2, "0")}:00`;
}
