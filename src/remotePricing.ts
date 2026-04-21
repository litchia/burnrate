import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { ModelPrice, sanitizePricing } from "./pricing";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 6000;

interface CacheFile {
  url: string;
  fetchedAt: string;
  data: Record<string, ModelPrice>;
}

export interface RemoteLoadResult {
  data: Record<string, ModelPrice>;
  source: "fresh" | "cache" | "stale-cache" | "empty";
  fetchedAt: string | null;
  error?: string;
}

export async function loadRemotePricing(url: string, cacheDir: string): Promise<RemoteLoadResult> {
  const cacheFile = path.join(cacheDir, "remote-pricing.json");
  const cached = await readCache(cacheFile);

  const isFresh =
    cached &&
    cached.url === url &&
    Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS;

  if (isFresh) {
    return { data: cached!.data, source: "cache", fetchedAt: cached!.fetchedAt };
  }

  try {
    const raw = await fetchJson(url);
    const data = sanitizePricing(raw);
    const fetchedAt = new Date().toISOString();
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(cacheFile, JSON.stringify({ url, fetchedAt, data } satisfies CacheFile));
    return { data, source: "fresh", fetchedAt };
  } catch (err: any) {
    if (cached) {
      return {
        data: cached.data,
        source: "stale-cache",
        fetchedAt: cached.fetchedAt,
        error: err?.message || String(err),
      };
    }
    return { data: {}, source: "empty", fetchedAt: null, error: err?.message || String(err) };
  }
}

async function readCache(file: string): Promise<CacheFile | null> {
  try {
    const txt = await fs.promises.readFile(file, "utf8");
    const parsed = JSON.parse(txt);
    if (parsed?.url && parsed?.fetchedAt && parsed?.data) return parsed;
  } catch {}
  return null;
}

function fetchJson(url: string, redirectsLeft = 5): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(
      url,
      { timeout: FETCH_TIMEOUT_MS, headers: { "User-Agent": "claude-cost-tracker", Accept: "application/json, text/plain, */*" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          fetchJson(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e: any) { reject(new Error(`Invalid JSON: ${e?.message || e}`)); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}
