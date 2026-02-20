interface FeedRefreshResult {
  feedId: string;
  feedTitle: string;
  method: 'stream' | 'proxy' | 'cached';
  success: boolean;
  durationMs: number;
  episodesFound: number;
  newEpisodes: number;
  error?: string;
  timestamp: number;
}

interface RefreshCycleStats {
  startedAt: number;
  completedAt?: number;
  totalFeeds: number;
  successes: number;
  failures: number;
  cached304: number;
  newEpisodes: number;
  totalDurationMs: number;
  results: FeedRefreshResult[];
}

const MAX_CYCLES = 24;
const MAX_FEED_HISTORY = 5;

const refreshCycles: RefreshCycleStats[] = [];
const feedHistory: Map<string, FeedRefreshResult[]> = new Map();
let currentCycle: RefreshCycleStats | null = null;

export function startRefreshCycle(totalFeeds: number): void {
  currentCycle = {
    startedAt: Date.now(),
    totalFeeds,
    successes: 0,
    failures: 0,
    cached304: 0,
    newEpisodes: 0,
    totalDurationMs: 0,
    results: [],
  };
}

export function recordFeedResult(result: FeedRefreshResult): void {
  if (currentCycle) {
    currentCycle.results.push(result);
    if (result.success) {
      if (result.method === 'cached') {
        currentCycle.cached304++;
      }
      currentCycle.successes++;
    } else {
      currentCycle.failures++;
    }
    currentCycle.newEpisodes += result.newEpisodes;
    currentCycle.totalDurationMs += result.durationMs;
  }

  const history = feedHistory.get(result.feedId) || [];
  history.unshift(result);
  if (history.length > MAX_FEED_HISTORY) history.pop();
  feedHistory.set(result.feedId, history);
}

export function endRefreshCycle(): void {
  if (currentCycle) {
    currentCycle.completedAt = Date.now();
    refreshCycles.unshift(currentCycle);
    if (refreshCycles.length > MAX_CYCLES) refreshCycles.pop();
    currentCycle = null;
  }
}

export function getVitals() {
  const allResults = refreshCycles.flatMap(c => c.results);
  const totalAttempts = allResults.length;
  const streamCount = allResults.filter(r => r.method === 'stream' && r.success).length;
  const proxyCount = allResults.filter(r => r.method === 'proxy' && r.success).length;
  const cachedCount = allResults.filter(r => r.method === 'cached').length;
  const failCount = allResults.filter(r => !r.success).length;

  const successfulDurations = allResults.filter(r => r.success && r.method !== 'cached').map(r => r.durationMs);
  const avgDurationMs = successfulDurations.length > 0
    ? Math.round(successfulDurations.reduce((a, b) => a + b, 0) / successfulDurations.length)
    : 0;

  const failingFeeds: { feedId: string; feedTitle: string; lastError: string; failCount: number; lastAttempt: number }[] = [];
  feedHistory.forEach((history, feedId) => {
    const recentFails = history.filter(r => !r.success);
    if (recentFails.length > 0) {
      failingFeeds.push({
        feedId,
        feedTitle: history[0].feedTitle,
        lastError: recentFails[0].error || 'Unknown',
        failCount: recentFails.length,
        lastAttempt: history[0].timestamp,
      });
    }
  });
  failingFeeds.sort((a, b) => b.failCount - a.failCount);

  return {
    summary: {
      totalAttempts,
      streamSuccesses: streamCount,
      proxySuccesses: proxyCount,
      cached304: cachedCount,
      failures: failCount,
      successRate: totalAttempts > 0 ? Math.round(((totalAttempts - failCount) / totalAttempts) * 100) : 100,
      avgDurationMs,
      cacheHitRate: totalAttempts > 0 ? Math.round((cachedCount / totalAttempts) * 100) : 0,
    },
    recentCycles: refreshCycles.slice(0, 10).map(c => ({
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      totalFeeds: c.totalFeeds,
      successes: c.successes,
      failures: c.failures,
      cached304: c.cached304,
      newEpisodes: c.newEpisodes,
      totalDurationMs: c.totalDurationMs,
      durationSec: c.completedAt ? Math.round((c.completedAt - c.startedAt) / 1000) : null,
    })),
    failingFeeds: failingFeeds.slice(0, 20),
    currentCycle: currentCycle ? {
      startedAt: currentCycle.startedAt,
      totalFeeds: currentCycle.totalFeeds,
      completed: currentCycle.results.length,
      successes: currentCycle.successes,
      failures: currentCycle.failures,
      elapsedSec: Math.round((Date.now() - currentCycle.startedAt) / 1000),
    } : null,
  };
}
