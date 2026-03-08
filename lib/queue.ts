import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiUrl } from "@/lib/query-client";
import { getDeviceId } from "@/lib/device-id";

const QUEUE_KEY = "@shiurpod_queue";

export interface QueueItem {
  episodeId: string;
  feedId: string;
  addedAt: number;
}

async function syncQueueToServer(queue: QueueItem[]): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    const baseUrl = getApiUrl();
    await fetch(`${baseUrl}/api/queue/${deviceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: queue.map((item, index) => ({
          episodeId: item.episodeId,
          feedId: item.feedId,
          position: index,
        })),
      }),
    });
  } catch {}
}

export async function fetchQueueFromServer(): Promise<QueueItem[]> {
  try {
    const deviceId = await getDeviceId();
    const baseUrl = getApiUrl();
    const res = await fetch(`${baseUrl}/api/queue/${deviceId}`);
    if (!res.ok) return [];
    const items = await res.json();
    return items.map((item: any) => ({
      episodeId: item.episodeId,
      feedId: item.feedId,
      addedAt: new Date(item.addedAt).getTime(),
    }));
  } catch {
    return [];
  }
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
    syncQueueToServer(queue);
  } catch (e) {
    console.error("Failed to add to queue:", e);
  }
}

export async function removeFromQueue(episodeId: string): Promise<void> {
  try {
    const queue = await getQueue();
    const filtered = queue.filter((item) => item.episodeId !== episodeId);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
    syncQueueToServer(filtered);
  } catch (e) {
    console.error("Failed to remove from queue:", e);
  }
}

export async function clearQueue(): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([]));
    syncQueueToServer([]);
  } catch (e) {
    console.error("Failed to clear queue:", e);
  }
}

export async function reorderQueue(items: QueueItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    syncQueueToServer(items);
  } catch (e) {
    console.error("Failed to reorder queue:", e);
  }
}

export async function initQueueFromServer(): Promise<QueueItem[]> {
  try {
    const localQueue = await getQueue();
    if (localQueue.length > 0) {
      syncQueueToServer(localQueue);
      return localQueue;
    }
    const serverQueue = await fetchQueueFromServer();
    if (serverQueue.length > 0) {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(serverQueue));
    }
    return serverQueue;
  } catch {
    return [];
  }
}
