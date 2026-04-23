import { PricingTable, Usage } from "./pricing";
import { AnalyzeSource, CodexQuotaSnapshot, NormalizedTurn, ProviderId, ProviderMetaEvent } from "./providerAdapter";
import { claudeCodeAdapter, defaultClaudeRoot } from "./claudeCodeAdapter";
import { codexAdapter, defaultCodexRoot } from "./codexAdapter";

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
  providers: ProviderBreakdown;
}

export interface Spike {
  provider: NormalizedTurn["provider"];
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
  providers: ProviderBreakdown;
}

export interface ProviderBucketStat {
  cost: number;
  tokens: number;
  messages: number;
}

export interface ProviderSummary extends ProviderBucketStat {
  sessions: number;
  unknownMessages: number;
}

export interface AnalysisResult {
  byProject: Record<string, Omit<ProjectStats, "sessions"> & { sessions: number }>;
  byDay: Record<string, number>;
  byHour: Record<string, number>;
  byDayTokens: Record<string, number>;
  byHourTokens: Record<string, number>;
  byProvider: Partial<Record<ProviderId, ProviderSummary>>;
  byDayProviders: Record<string, Partial<Record<ProviderId, ProviderBucketStat>>>;
  byHourProviders: Record<string, Partial<Record<ProviderId, ProviderBucketStat>>>;
  byDayModels: Record<string, Record<string, ModelStat>>;
  byHourModels: Record<string, Record<string, ModelStat>>;
  byModel: Record<string, ModelStat>;
  codexQuota: CodexQuotaSummary | null;
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

export interface CodexQuotaSummary {
  usedPercent: number;
  windowMinutes: number;
  windowStart: string;
  resetsAt: string;
  planType: string;
  sampledAt: string;
  isCurrentWindow: boolean;
  windowTokensUsed: number;
  avgDailyTokens7d: number;
  activeDays7d: number;
  projectedExhaustsAt: string | null;
  recentLimitExceededCount: number;
  mostRecentLimitExceededAt: string | null;
}

export interface AnalyzeOptions {
  since?: string;
  spikeThreshold?: number;
  pricing: PricingTable;
  includeHourBuckets?: boolean;
  includeBucketModels?: "none" | "day" | "hour" | "both";
}

export type ProviderFilter = "all" | ProviderId;

type ProviderBreakdown = Partial<Record<ProviderId, ProviderBucketStat>>;
type CodexTokenEvent = { timestamp: string; tokens: number };

export { defaultClaudeRoot };
export { defaultCodexRoot };

export async function analyze(root: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
  return analyzeSources([{ adapter: claudeCodeAdapter, root }], opts);
}

export async function analyzeDefaults(opts: AnalyzeOptions): Promise<AnalysisResult> {
  return analyzeForProvider("all", opts);
}

export async function analyzeForProvider(provider: ProviderFilter, opts: AnalyzeOptions): Promise<AnalysisResult> {
  return analyzeSources(defaultSourcesFor(provider), opts);
}

export async function analyzeSources(sources: AnalyzeSource[], opts: AnalyzeOptions): Promise<AnalysisResult> {
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
  const byProvider: Partial<Record<ProviderId, ProviderSummary & { sessionKeys: Set<string> }>> = {};
  const byDayProviders: Record<string, Partial<Record<ProviderId, ProviderBucketStat>>> = {};
  const byHourProviders: Record<string, Partial<Record<ProviderId, ProviderBucketStat>>> = {};
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
  const codexTokenEventsAll: CodexTokenEvent[] = [];
  const codexQuotaSnapshots: CodexQuotaSnapshot[] = [];
  const codexLimitExceededEvents: string[] = [];

  const tasks = await collectProviderTasks(sources);
  scannedFiles = tasks.length;
  if (tasks.length === 0) return emptyResult();

  await asyncPool(8, tasks, async ({ adapter, task }) => {
    await adapter.processFile(task, (turn) => {
      const usage: Usage = turn.usage;
      const tokens = totalTrackedTokens(usage);
      if (turn.provider === "codex" && turn.timestamp && tokens > 0) {
        codexTokenEventsAll.push({ timestamp: turn.timestamp, tokens });
      }
      if (since && turn.day < since) return;

      const model = turn.model || "unknown";
      if (model.toLowerCase() === "<synthetic>") {
        // Claude Code sometimes emits metadata-only assistant turns (e.g. tooling/trace artifacts).
        syntheticMessages++;
        return;
      }

      const result = pricing.priceFor(model, usage);
      const cost = result.cost;

      totalMessages++;
      if (tokens === 0) return;

      const stats = getOrCreateProjectStats(byProject, turn.project, turn.rawDir);
      stats.cost += cost;
      stats.inTokens += usage.input_tokens ?? 0;
      // Until the UI gets a dedicated reasoning-output row, treat it as part
      // of output volume so totals stay accurate for Codex sessions.
      stats.outTokens += (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0);
      stats.cacheRead += usage.cache_read_input_tokens ?? 0;
      stats.cacheWrite += getCacheWriteTokens(usage);
      stats.sessions.add(turn.session);
      if (!result.isKnown) stats.unknownTokens += tokens;
      addProviderBreakdownStat(stats.providers, turn.provider, cost, tokens);
      allSessions.add(`${turn.provider}:${turn.rawDir}/${turn.session}`);
      const providerSummary = getOrCreateProviderSummary(byProvider, turn.provider);
      providerSummary.cost += cost;
      providerSummary.tokens += tokens;
      providerSummary.messages += 1;
      providerSummary.sessionKeys.add(`${turn.rawDir}/${turn.session}`);

      if (turn.day) byDay[turn.day] = (byDay[turn.day] ?? 0) + cost;
      if (turn.day) byDayTokens[turn.day] = (byDayTokens[turn.day] ?? 0) + tokens;
      if (includeHourBuckets && turn.hour) byHour[turn.hour] = (byHour[turn.hour] ?? 0) + cost;
      if (includeHourBuckets && turn.hour) byHourTokens[turn.hour] = (byHourTokens[turn.hour] ?? 0) + tokens;
      if (turn.day) addBucketProviderStat(byDayProviders, turn.day, turn.provider, cost, tokens);
      if (includeHourBuckets && turn.hour) addBucketProviderStat(byHourProviders, turn.hour, turn.provider, cost, tokens);

      addModelStat(byModel, model, cost, tokens, result.isKnown, turn.provider);
      if (includeDayModels && turn.day) addBucketModelStat(byDayModels, turn.day, model, cost, tokens, result.isKnown, turn.provider);
      if (includeHourModels && includeHourBuckets && turn.hour) addBucketModelStat(byHourModels, turn.hour, model, cost, tokens, result.isKnown, turn.provider);

      if (!result.isKnown) {
        unknownModels.add(model);
        unknownMessages++;
        providerSummary.unknownMessages += 1;
      }

      const isSpike = result.isKnown ? cost > spikeThreshold : tokens >= unpricedSpikeTokenThreshold;
      if (isSpike) {
        spikes.push({
          provider: turn.provider,
          project: turn.project,
          session: turn.session,
          ts: turn.timestamp,
          cost,
          model,
          usage,
          tokens,
          isKnown: result.isKnown,
        });
      }
    }, (meta) => {
      if (meta.type === "codexQuota") codexQuotaSnapshots.push(meta.snapshot);
      if (meta.type === "codexLimitExceeded" && meta.timestamp) codexLimitExceededEvents.push(meta.timestamp);
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
      providers: s.providers,
    };
    totals.cost += s.cost;
    totals.inTokens += s.inTokens;
    totals.outTokens += s.outTokens;
    totals.cacheRead += s.cacheRead;
    totals.cacheWrite += s.cacheWrite;
  }
  totals.sessions = allSessions.size;

  const byProviderOut: AnalysisResult["byProvider"] = {};
  for (const [provider, summary] of Object.entries(byProvider) as Array<[ProviderId, ProviderSummary & { sessionKeys: Set<string> }]>) {
    byProviderOut[provider] = {
      cost: summary.cost,
      tokens: summary.tokens,
      messages: summary.messages,
      sessions: summary.sessionKeys.size,
      unknownMessages: summary.unknownMessages,
    };
  }

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
    byDay,
    byHour,
    byDayTokens,
    byHourTokens,
    byProvider: byProviderOut,
    byDayProviders,
    byHourProviders,
    byDayModels,
    byHourModels,
    byModel,
    codexQuota: buildCodexQuotaSummary(codexQuotaSnapshots, codexTokenEventsAll, codexLimitExceededEvents),
    unknownModels: Array.from(unknownModels).sort(),
    spikes: spikesOut,
    totals,
    scannedFiles,
    generatedAt: new Date().toISOString(),
  };
}

function emptyResult(): AnalysisResult {
  return {
    byProject: {},
    byDay: {},
    byHour: {},
    byDayTokens: {},
    byHourTokens: {},
    byProvider: {},
    byDayProviders: {},
    byHourProviders: {},
    byDayModels: {},
    byHourModels: {},
    byModel: {},
    codexQuota: null,
    unknownModels: [],
    spikes: [],
    totals: {
      cost: 0,
      inTokens: 0,
      outTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      sessions: 0,
      messages: 0,
      unknownMessages: 0,
      syntheticMessages: 0,
    },
    scannedFiles: 0,
    generatedAt: new Date().toISOString(),
  };
}

function buildCodexQuotaSummary(
  snapshots: CodexQuotaSnapshot[],
  codexTokenEventsAll: CodexTokenEvent[],
  codexLimitExceededEvents: string[],
): CodexQuotaSummary | null {
  if (snapshots.length === 0) return null;
  const latest = snapshots
    .slice()
    .sort((a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""))[0];
  const sampledAt = new Date(latest.timestamp);
  const resetAt = new Date(latest.resetsAt * 1000);
  if (Number.isNaN(sampledAt.getTime()) || Number.isNaN(resetAt.getTime())) return null;

  const windowStart = new Date(resetAt.getTime() - latest.windowMinutes * 60 * 1000);
  const now = new Date();
  const isCurrentWindow = now.getTime() >= windowStart.getTime() && now.getTime() <= resetAt.getTime();

  const sevenDayStart = new Date(sampledAt.getTime());
  sevenDayStart.setHours(0, 0, 0, 0);
  sevenDayStart.setDate(sevenDayStart.getDate() - 6);

  let windowTokensUsed = 0;
  let trailingTokens = 0;
  let activeDays7d = 0;
  const trailingDayTokens: Record<string, number> = {};

  for (const event of codexTokenEventsAll) {
    if (!event.tokens) continue;
    const eventTime = new Date(event.timestamp);
    if (Number.isNaN(eventTime.getTime())) continue;
    if (eventTime.getTime() >= windowStart.getTime() && eventTime.getTime() <= sampledAt.getTime()) {
      windowTokensUsed += event.tokens;
    }
    if (eventTime.getTime() >= sevenDayStart.getTime() && eventTime.getTime() <= sampledAt.getTime()) {
      const dayKey = localDayKeyFromDate(eventTime);
      trailingDayTokens[dayKey] = (trailingDayTokens[dayKey] ?? 0) + event.tokens;
    }
  }

  for (const tokens of Object.values(trailingDayTokens)) {
    trailingTokens += tokens;
    if (tokens > 0) activeDays7d++;
  }

  const avgDailyTokens7d = activeDays7d > 0 ? trailingTokens / activeDays7d : 0;
  let projectedExhaustsAt: string | null = null;

  if (
    isCurrentWindow &&
    activeDays7d >= 3 &&
    avgDailyTokens7d > 0 &&
    latest.usedPercent > 0 &&
    latest.usedPercent < 100 &&
    windowTokensUsed > 0
  ) {
    const remainingTokensEstimate = windowTokensUsed * ((100 - latest.usedPercent) / latest.usedPercent);
    const daysRemaining = remainingTokensEstimate / avgDailyTokens7d;
    const projected = new Date(sampledAt.getTime() + daysRemaining * 24 * 60 * 60 * 1000);
    if (projected.getTime() <= resetAt.getTime()) {
      projectedExhaustsAt = projected.toISOString();
    }
  }

  const limitHitsInWindow = codexLimitExceededEvents
    .map((timestamp) => new Date(timestamp))
    .filter((date) => !Number.isNaN(date.getTime()))
    .filter((date) => date.getTime() >= windowStart.getTime() && date.getTime() <= resetAt.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  return {
    usedPercent: latest.usedPercent,
    windowMinutes: latest.windowMinutes,
    windowStart: windowStart.toISOString(),
    resetsAt: resetAt.toISOString(),
    planType: latest.planType,
    sampledAt: latest.timestamp,
    isCurrentWindow,
    windowTokensUsed,
    avgDailyTokens7d,
    activeDays7d,
    projectedExhaustsAt,
    recentLimitExceededCount: limitHitsInWindow.length,
    mostRecentLimitExceededAt: limitHitsInWindow[0]?.toISOString() ?? null,
  };
}

async function collectProviderTasks(
  sources: AnalyzeSource[],
): Promise<Array<{ adapter: AnalyzeSource["adapter"]; task: Awaited<ReturnType<AnalyzeSource["adapter"]["listSessionFiles"]>>[number] }>> {
  const taskGroups = await Promise.all(
    sources.map(async (source) => {
      const tasks = await source.adapter.listSessionFiles(source.root);
      return tasks.map((task) => ({ adapter: source.adapter, task }));
    }),
  );
  return taskGroups.flat();
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
        providers: {},
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
  provider: ProviderId,
): void {
  const bucket = buckets[bucketKey] ?? {};
  addModelStat(bucket, model, cost, tokens, isKnown, provider);
  buckets[bucketKey] = bucket;
}

function addModelStat(
  statsByModel: Record<string, ModelStat>,
  model: string,
  cost: number,
  tokens: number,
  isKnown: boolean,
  provider: ProviderId,
): void {
  const stat = statsByModel[model] ?? { cost: 0, tokens: 0, messages: 0, isKnown, providers: {} };
  stat.cost += cost;
  stat.tokens += tokens;
  stat.messages += 1;
  stat.isKnown = stat.isKnown && isKnown;
  addProviderBreakdownStat(stat.providers, provider, cost, tokens);
  statsByModel[model] = stat;
}

function addBucketProviderStat(
  buckets: Record<string, Partial<Record<ProviderId, ProviderBucketStat>>>,
  bucketKey: string,
  provider: ProviderId,
  cost: number,
  tokens: number,
): void {
  const bucket = buckets[bucketKey] ?? {};
  const stat = bucket[provider] ?? { cost: 0, tokens: 0, messages: 0 };
  stat.cost += cost;
  stat.tokens += tokens;
  stat.messages += 1;
  bucket[provider] = stat;
  buckets[bucketKey] = bucket;
}

function addProviderBreakdownStat(
  breakdown: ProviderBreakdown,
  provider: ProviderId,
  cost: number,
  tokens: number,
): void {
  const stat = breakdown[provider] ?? { cost: 0, tokens: 0, messages: 0 };
  stat.cost += cost;
  stat.tokens += tokens;
  stat.messages += 1;
  breakdown[provider] = stat;
}

function localDayKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getOrCreateProviderSummary(
  summaries: Partial<Record<ProviderId, ProviderSummary & { sessionKeys: Set<string> }>>,
  provider: ProviderId,
): ProviderSummary & { sessionKeys: Set<string> } {
  const existing = summaries[provider];
  if (existing) return existing;
  const created = {
    cost: 0,
    tokens: 0,
    messages: 0,
    sessions: 0,
    unknownMessages: 0,
    sessionKeys: new Set<string>(),
  };
  summaries[provider] = created;
  return created;
}

function defaultSourcesFor(provider: ProviderFilter): AnalyzeSource[] {
  const allSources: AnalyzeSource[] = [
    { adapter: claudeCodeAdapter, root: defaultClaudeRoot() },
    { adapter: codexAdapter, root: defaultCodexRoot() },
  ];
  if (provider === "all") return allSources;
  return allSources.filter((source) => source.adapter.id === provider);
}

function totalTrackedTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.reasoning_output_tokens ?? 0) +
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
