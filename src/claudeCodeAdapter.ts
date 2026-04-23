import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { Usage } from "./pricing";
import { NormalizedTurn, ProviderAdapter, ProviderFileTask } from "./providerAdapter";

export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  defaultRoot() {
    return defaultClaudeRoot();
  },
  async listSessionFiles(root: string): Promise<ProviderFileTask[]> {
    if (!fs.existsSync(root)) return [];

    const projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
    const tasks: ProviderFileTask[] = [];

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;
      const projectDir = path.join(root, dirent.name);
      const decoded = decodeProjectDir(dirent.name);
      let files: string[] = [];
      try {
        files = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        tasks.push({
          provider: "claude-code",
          full: path.join(projectDir, file),
          session: path.basename(file, ".jsonl"),
          rawDir: dirent.name,
          fallbackProject: decoded,
        });
      }
    }

    return tasks;
  },
  async processFile(
    task: ProviderFileTask,
    onTurn: (turn: NormalizedTurn) => void,
    _onMeta?: (event: never) => void,
  ): Promise<void> {
    const stream = fs.createReadStream(task.full, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const latestAssistantTurns = new Map<string, NormalizedTurn>();
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const turn = normalizeAssistantTurn(event, task);
        if (turn) latestAssistantTurns.set(turn.key, turn);
      } catch {}
    }
    for (const turn of latestAssistantTurns.values()) onTurn(turn);
  },
};

export function defaultClaudeRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function decodeProjectDir(dirName: string): string {
  if (!dirName) return dirName;
  // Claude Code on macOS/Linux encodes "/work/foo" as "-work-foo".
  // On Windows the encoding is unverified and ambiguous (drive letters,
  // backslashes), so we only attempt decoding on POSIX. The extension
  // relies on the per-event `cwd` field for project attribution; this
  // decoder is a best-effort fallback for events missing cwd.
  if (process.platform === "win32") return dirName;
  return dirName.replace(/-/g, "/");
}

function normalizeAssistantTurn(event: any, task: ProviderFileTask): NormalizedTurn | null {
  if (event?.type !== "assistant" || !event.message?.usage) return null;
  const key = String(event.message.id || event.uuid || "");
  if (!key) return null;
  const usage = event.message.usage as Usage;
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
  return {
    provider: "claude-code",
    key,
    timestamp,
    day: localDayKey(timestamp),
    hour: localHourKey(timestamp),
    project: typeof event.cwd === "string" && event.cwd ? event.cwd : task.fallbackProject,
    model: typeof event.message.model === "string" ? event.message.model : "unknown",
    usage,
    session: task.session,
    rawDir: task.rawDir,
  };
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
