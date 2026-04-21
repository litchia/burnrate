import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { PricingTable, Usage } from "./pricing";

export interface ProjectStats {
  project: string;
  rawDir: string;
  cost: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: Set<string>;
  unknownTokens: number;
}

export interface Spike {
  project: string;
  session: string;
  ts: string;
  cost: number;
  model: string;
  usage: Usage;
}

export interface ModelStat {
  cost: number;
  tokens: number;
  messages: number;
  isKnown: boolean;
}

export interface AnalysisResult {
  byProject: Record<string, Omit<ProjectStats, "sessions"> & { sessions: number }>;
  byDay: Record<string, number>;
  byModel: Record<string, ModelStat>;
  unknownModels: string[];
  spikes: Spike[];
  totals: {
    cost: number;
    inTokens: number;
    outTokens: number;
    cacheRead: number;
    cacheWrite: number;
    sessions: number;
    messages: number;
    unknownMessages: number;
  };
  scannedFiles: number;
  generatedAt: string;
}

export interface AnalyzeOptions {
  since?: string;
  spikeThreshold?: number;
  pricing: PricingTable;
}

export function defaultClaudeRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function decodeProjectDir(dirName: string): string {
  if (!dirName) return dirName;
  return dirName.replace(/-/g, "/");
}

export async function analyze(root: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
  const spikeThreshold = opts.spikeThreshold ?? 1.0;
  const since = opts.since;
  const pricing = opts.pricing;

  const byProject = new Map<string, ProjectStats>();
  const byDay: Record<string, number> = {};
  const byModel: Record<string, ModelStat> = {};
  const unknownModels = new Set<string>();
  const spikes: Spike[] = [];

  let totalMessages = 0;
  let unknownMessages = 0;
  let scannedFiles = 0;
  const allSessions = new Set<string>();

  if (!fs.existsSync(root)) return emptyResult();

  const projectDirs = await fs.promises.readdir(root, { withFileTypes: true });

  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const projectDir = path.join(root, dirent.name);
    const decoded = decodeProjectDir(dirent.name);

    let stats = byProject.get(decoded);
    if (!stats) {
      stats = {
        project: decoded, rawDir: dirent.name,
        cost: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
        sessions: new Set<string>(),
        unknownTokens: 0,
      };
      byProject.set(decoded, stats);
    }

    let files: string[] = [];
    try {
      files = (await fs.promises.readdir(projectDir)).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const file of files) {
      const full = path.join(projectDir, file);
      const session = path.basename(file, ".jsonl");
      scannedFiles++;

      await processFile(full, (event) => {
        if (event.type !== "assistant" || !event.message?.usage) return;
        const ts: string = event.timestamp || "";
        if (since && ts && ts.slice(0, 10) < since) return;

        const usage: Usage = event.message.usage;
        const model: string = event.message.model || "unknown";
        const result = pricing.priceFor(model, usage);
        const cost = result.cost;
        const day = ts.slice(0, 10);
        const tokens =
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);

        stats!.cost       += cost;
        stats!.inTokens   += usage.input_tokens                ?? 0;
        stats!.outTokens  += usage.output_tokens               ?? 0;
        stats!.cacheRead  += usage.cache_read_input_tokens     ?? 0;
        stats!.cacheWrite += usage.cache_creation_input_tokens ?? 0;
        stats!.sessions.add(session);
        if (!result.isKnown) stats!.unknownTokens += tokens;
        allSessions.add(`${dirent.name}/${session}`);

        if (day) byDay[day] = (byDay[day] ?? 0) + cost;

        const m = byModel[model] ?? { cost: 0, tokens: 0, messages: 0, isKnown: result.isKnown };
        m.cost += cost; m.tokens += tokens; m.messages += 1; m.isKnown = result.isKnown;
        byModel[model] = m;

        if (!result.isKnown) {
          unknownModels.add(model);
          unknownMessages++;
        }
        totalMessages++;

        if (cost > spikeThreshold) {
          spikes.push({ project: decoded, session, ts, cost, model, usage });
        }
      });
    }
  }

  const byProjectOut: AnalysisResult["byProject"] = {};
  const totals = {
    cost: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
    sessions: 0, messages: totalMessages, unknownMessages,
  };
  for (const s of byProject.values()) {
    if (s.cost === 0 && s.sessions.size === 0 && s.unknownTokens === 0) continue;
    byProjectOut[s.project] = {
      project: s.project, rawDir: s.rawDir,
      cost: s.cost, inTokens: s.inTokens, outTokens: s.outTokens,
      cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
      sessions: s.sessions.size,
      unknownTokens: s.unknownTokens,
    };
    totals.cost       += s.cost;
    totals.inTokens   += s.inTokens;
    totals.outTokens  += s.outTokens;
    totals.cacheRead  += s.cacheRead;
    totals.cacheWrite += s.cacheWrite;
  }
  totals.sessions = allSessions.size;

  spikes.sort((a, b) => b.cost - a.cost);

  return {
    byProject: byProjectOut,
    byDay, byModel,
    unknownModels: Array.from(unknownModels).sort(),
    spikes: spikes.slice(0, 50),
    totals,
    scannedFiles,
    generatedAt: new Date().toISOString(),
  };
}

function emptyResult(): AnalysisResult {
  return {
    byProject: {}, byDay: {}, byModel: {},
    unknownModels: [],
    spikes: [],
    totals: { cost: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, messages: 0, unknownMessages: 0 },
    scannedFiles: 0,
    generatedAt: new Date().toISOString(),
  };
}

async function processFile(file: string, onEvent: (event: any) => void): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { onEvent(JSON.parse(line)); } catch {}
  }
}
