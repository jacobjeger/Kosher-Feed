import AsyncStorage from "@react-native-async-storage/async-storage";

const QUEUE_KEY = "@shiurpod_queue";

export interface QueueItem {
  episodeId: string;
  feedId: string;
  addedAt: number;
}

export async function getQueue(): Promise<QueueItem[]> {
  try {
    const data = await AsyncStorage.getItem(QUEUE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function addToQueue(episodeId: string, feedId: string): Promise<void> {
  try {
    const queue = await getQueue();
    const exists = queue.some((item) => item.episodeId === episodeId);
    if (exists) return;
    queue.push({ episodeId, feedId, addedAt: Date.now() });
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.error("Failed to add to queue:", e);
  }
}

export async function removeFromQueue(episodeId: string): Promise<void> {
  try {
    const queue = await getQueue();
    const filtered = queue.filter((item) => item.episodeId !== episodeId);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.error("Failed to remove from queue:", e);
  }
}

export async function clearQueue(): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([]));
  } catch (e) {
    console.error("Failed to clear queue:", e);
  }
}

export async function reorderQueue(items: QueueItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch (e) {
    console.error("Failed to reorder queue:", e);
  }
}
