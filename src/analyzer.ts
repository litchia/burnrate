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
  // Cache creation input tokens (5m + 1h combined when available).
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
  tokens: number;
  isKnown: boolean;
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
  byHour: Record<string, number>;
  byDayTokens: Record<string, number>;
  byHourTokens: Record<string, number>;
  byDayModels: Record<string, Record<string, ModelStat>>;
  byHourModels: Record<string, Record<string, ModelStat>>;
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
    syntheticMessages: number;
  };
  scannedFiles: number;
  generatedAt: string;
}

export interface AnalyzeOptions {
  since?: string;
  spikeThreshold?: number;
  pricing: PricingTable;
  includeHourBuckets?: boolean;
  includeBucketModels?: "none" | "day" | "hour" | "both";
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
  const includeHourBuckets = opts.includeHourBuckets ?? false;
  const includeBucketModels = opts.includeBucketModels ?? "none";
  const includeDayModels = includeBucketModels === "day" || includeBucketModels === "both";
  const includeHourModels = includeBucketModels === "hour" || includeBucketModels === "both";

  const byProject = new Map<string, ProjectStats>();
  const byDay: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const byDayTokens: Record<string, number> = {};
  const byHourTokens: Record<string, number> = {};
  const byDayModels: Record<string, Record<string, ModelStat>> = {};
  const byHourModels: Record<string, Record<string, ModelStat>> = {};
  const byModel: Record<string, ModelStat> = {};
  const unknownModels = new Set<string>();
  const spikes: Spike[] = [];
  const unpricedSpikeTokenThreshold = 500_000;

  let totalMessages = 0;
  let unknownMessages = 0;
  let syntheticMessages = 0;
  let scannedFiles = 0;
  const allSessions = new Set<string>();

  if (!fs.existsSync(root)) return emptyResult();

  const projectDirs = await fs.promises.readdir(root, { withFileTypes: true });

  type FileTask = { full: string; session: string; rawDir: string; decoded: string };
  const tasks: FileTask[] = [];

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
        full: path.join(projectDir, file),
        session: path.basename(file, ".jsonl"),
        rawDir: dirent.name,
        decoded,
      });
    }
  }

  scannedFiles = tasks.length;

  await asyncPool(8, tasks, async (task) => {
      await processFile(task.full, (turn) => {
        if (since && turn.day < since) return;

        const usage: Usage = turn.usage;
        const model: string = turn.model || "unknown";
        if (model.toLowerCase() === "<synthetic>") {
          // Claude Code sometimes emits metadata-only assistant turns (e.g. tooling/trace artifacts).
          syntheticMessages++;
          return;
        }
        const result = pricing.priceFor(model, usage);
        const cost = result.cost;
        const day = turn.day;
        const project = turn.project || task.decoded;
        const tokens = totalTrackedTokens(usage);

        totalMessages++;
        if (tokens === 0) return;

        const stats = getOrCreateProjectStats(byProject, project, task.rawDir);
        stats.cost       += cost;
        stats.inTokens   += usage.input_tokens                ?? 0;
        stats.outTokens  += usage.output_tokens               ?? 0;
        stats.cacheRead  += usage.cache_read_input_tokens     ?? 0;
        stats.cacheWrite += getCacheWriteTokens(usage);
        stats.sessions.add(task.session);
        if (!result.isKnown) stats.unknownTokens += tokens;
        allSessions.add(`${task.rawDir}/${task.session}`);

        if (day) byDay[day] = (byDay[day] ?? 0) + cost;
        if (day) byDayTokens[day] = (byDayTokens[day] ?? 0) + tokens;
        if (includeHourBuckets && turn.hour) byHour[turn.hour] = (byHour[turn.hour] ?? 0) + cost;
        if (includeHourBuckets && turn.hour) byHourTokens[turn.hour] = (byHourTokens[turn.hour] ?? 0) + tokens;

        addModelStat(byModel, model, cost, tokens, result.isKnown);
        if (includeDayModels && day) addBucketModelStat(byDayModels, day, model, cost, tokens, result.isKnown);
        if (includeHourModels && includeHourBuckets && turn.hour) addBucketModelStat(byHourModels, turn.hour, model, cost, tokens, result.isKnown);

        if (!result.isKnown) {
          unknownModels.add(model);
          unknownMessages++;
        }

        const isSpike = result.isKnown ? cost > spikeThreshold : tokens >= unpricedSpikeTokenThreshold;
        if (isSpike) {
          spikes.push({ project, session: task.session, ts: turn.timestamp, cost, model, usage, tokens, isKnown: result.isKnown });
        }
      });
  });

  const byProjectOut: AnalysisResult["byProject"] = {};
  const totals = {
    cost: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
    sessions: 0, messages: totalMessages, unknownMessages, syntheticMessages,
  };
  for (const s of byProject.values()) {
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

  // Keep both priced and unpriced spikes visible. If we only sort by USD cost,
  // token-based (unpriced) spikes would cluster at cost=$0 and get truncated.
  const pricedSpikes = spikes
    .filter((s) => s.isKnown)
    .sort((a, b) => b.cost - a.cost);
  const unpricedSpikes = spikes
    .filter((s) => !s.isKnown)
    .sort((a, b) => b.tokens - a.tokens);

  // The UI currently renders 10 priced + 10 unpriced spikes, so keep the payload aligned.
  const spikeCap = 20;
  const unpricedBudget = Math.min(10, unpricedSpikes.length);
  const pricedBudget = Math.min(spikeCap - unpricedBudget, pricedSpikes.length);

  const spikesOut: Spike[] = [];
  spikesOut.push(...pricedSpikes.slice(0, pricedBudget));
  spikesOut.push(...unpricedSpikes.slice(0, unpricedBudget));
  if (spikesOut.length < spikeCap) {
    spikesOut.push(...pricedSpikes.slice(pricedBudget, pricedBudget + (spikeCap - spikesOut.length)));
  }
  if (spikesOut.length < spikeCap) {
    spikesOut.push(...unpricedSpikes.slice(unpricedBudget, unpricedBudget + (spikeCap - spikesOut.length)));
  }

  return {
    byProject: byProjectOut,
    byDay, byHour, byDayTokens, byHourTokens, byDayModels, byHourModels, byModel,
    unknownModels: Array.from(unknownModels).sort(),
    spikes: spikesOut,
    totals,
    scannedFiles,
    generatedAt: new Date().toISOString(),
  };
}

function emptyResult(): AnalysisResult {
  return {
    byProject: {}, byDay: {}, byHour: {}, byDayTokens: {}, byHourTokens: {}, byDayModels: {}, byHourModels: {}, byModel: {},
    unknownModels: [],
    spikes: [],
    totals: { cost: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, messages: 0, unknownMessages: 0, syntheticMessages: 0 },
    scannedFiles: 0,
    generatedAt: new Date().toISOString(),
  };
}

async function processFile(file: string, onTurn: (turn: NormalizedTurn) => void): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const latestAssistantTurns = new Map<string, NormalizedTurn>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const turn = normalizeAssistantTurn(event);
      if (turn) latestAssistantTurns.set(turn.key, turn);
    } catch {}
  }
  for (const turn of latestAssistantTurns.values()) onTurn(turn);
}

interface NormalizedTurn {
  key: string;
  timestamp: string;
  day: string;
  hour: string;
  project: string;
  model: string;
  usage: Usage;
}

function normalizeAssistantTurn(event: any): NormalizedTurn | null {
  if (event?.type !== "assistant" || !event.message?.usage) return null;
  const key = String(event.message.id || event.uuid || "");
  if (!key) return null;
  const usage = event.message.usage as Usage;
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
  return {
    key,
    timestamp,
    day: localDayKey(timestamp),
    hour: localHourKey(timestamp),
    project: typeof event.cwd === "string" && event.cwd ? event.cwd : "",
    model: typeof event.message.model === "string" ? event.message.model : "unknown",
    usage,
  };
}

function getOrCreateProjectStats(byProject: Map<string, ProjectStats>, project: string, rawDir: string): ProjectStats {
  let stats = byProject.get(project);
  if (!stats) {
    stats = {
      project,
      rawDir,
      cost: 0,
      inTokens: 0,
      outTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      sessions: new Set<string>(),
      unknownTokens: 0,
    };
    byProject.set(project, stats);
  }
  return stats;
}

function addBucketModelStat(
  buckets: Record<string, Record<string, ModelStat>>,
  bucketKey: string,
  model: string,
  cost: number,
  tokens: number,
  isKnown: boolean,
): void {
  const bucket = buckets[bucketKey] ?? {};
  addModelStat(bucket, model, cost, tokens, isKnown);
  buckets[bucketKey] = bucket;
}

function addModelStat(
  statsByModel: Record<string, ModelStat>,
  model: string,
  cost: number,
  tokens: number,
  isKnown: boolean,
): void {
  const stat = statsByModel[model] ?? { cost: 0, tokens: 0, messages: 0, isKnown };
  stat.cost += cost;
  stat.tokens += tokens;
  stat.messages += 1;
  stat.isKnown = isKnown;
  statsByModel[model] = stat;
}

function totalTrackedTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    getCacheWriteTokens(usage)
  );
}

function getCacheWriteTokens(usage: Usage): number {
  const cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (cacheWrite5m > 0 || cacheWrite1h > 0) return cacheWrite5m + cacheWrite1h;
  return usage.cache_creation_input_tokens ?? 0;
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

async function asyncPool<T>(
  concurrency: number,
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
}
