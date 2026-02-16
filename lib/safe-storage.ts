import AsyncStorage from "@react-native-async-storage/async-storage";

export async function safeGetJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    try {
      await AsyncStorage.removeItem(key);
    } catch {}
    return fallback;
  }
}

export async function safeSetJSON(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`Failed to save ${key}:`, e);
  }
}

export function safeNumber(val: unknown, fallback: number = 0): number {
  if (typeof val !== "number" || !isFinite(val)) return fallback;
  return val;
}
