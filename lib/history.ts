import AsyncStorage from "@react-native-async-storage/async-storage";

const HISTORY_KEY = "@shiurpod_history";
const MAX_HISTORY = 50;

export interface HistoryItem {
  episodeId: string;
  feedId: string;
  title: string;
  feedTitle: string;
  feedImageUrl: string | null;
  playedAt: number;
  positionMs: number;
  durationMs: number;
}

export async function getHistory(): Promise<HistoryItem[]> {
  try {
    const data = await AsyncStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function addToHistory(item: Omit<HistoryItem, "playedAt">): Promise<void> {
  try {
    const history = await getHistory();
    const filtered = history.filter((h) => h.episodeId !== item.episodeId);
    const newItem: HistoryItem = { ...item, playedAt: Date.now() };
    const updated = [newItem, ...filtered].slice(0, MAX_HISTORY);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error("Failed to add to history:", e);
  }
}

export async function updateHistoryPosition(
  episodeId: string,
  positionMs: number,
  durationMs: number
): Promise<void> {
  try {
    const history = await getHistory();
    const index = history.findIndex((h) => h.episodeId === episodeId);
    if (index >= 0) {
      history[index].positionMs = positionMs;
      history[index].durationMs = durationMs;
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }
  } catch (e) {
    console.error("Failed to update history position:", e);
  }
}

export async function clearHistory(): Promise<void> {
  try {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([]));
  } catch (e) {
    console.error("Failed to clear history:", e);
  }
}
