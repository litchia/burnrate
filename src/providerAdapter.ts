import { Usage } from "./pricing";

export type ProviderId = "claude-code" | "codex";

export interface ProviderFileTask {
  provider: ProviderId;
  full: string;
  session: string;
  rawDir: string;
  fallbackProject: string;
}

export interface NormalizedTurn {
  provider: ProviderId;
  key: string;
  timestamp: string;
  day: string;
  hour: string;
  project: string;
  model: string;
  usage: Usage;
  session: string;
  rawDir: string;
}

export interface CodexQuotaSnapshot {
  provider: "codex";
  timestamp: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
  planType: string;
  lastTurnTokens: number;
}

export type ProviderMetaEvent =
  | { type: "codexQuota"; snapshot: CodexQuotaSnapshot }
  | { type: "codexLimitExceeded"; timestamp: string; message: string };

export interface ProviderAdapter {
  id: ProviderId;
  defaultRoot(): string;
  listSessionFiles(root: string): Promise<ProviderFileTask[]>;
  processFile(
    task: ProviderFileTask,
    onTurn: (turn: NormalizedTurn) => void,
    onMeta?: (event: ProviderMetaEvent) => void,
  ): Promise<void>;
}

export interface AnalyzeSource {
  adapter: ProviderAdapter;
  root: string;
}
