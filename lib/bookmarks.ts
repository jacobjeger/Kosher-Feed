import AsyncStorage from "@react-native-async-storage/async-storage";

const BOOKMARKS_KEY = "@shiurpod_bookmarks";

export interface Bookmark {
  id: string;
  episodeId: string;
  feedId: string;
  positionMs: number;
  note: string;
  createdAt: number;
}

export async function getBookmarks(episodeId?: string): Promise<Bookmark[]> {
  try {
    const data = await AsyncStorage.getItem(BOOKMARKS_KEY);
    const all: Bookmark[] = data ? JSON.parse(data) : [];
    if (episodeId) {
      return all.filter((b) => b.episodeId === episodeId);
    }
    return all;
  } catch {
    return [];
  }
}

export async function addBookmark(
  bookmark: Omit<Bookmark, "id" | "createdAt">
): Promise<Bookmark> {
  const all = await getBookmarks();
  const newBookmark: Bookmark = {
    ...bookmark,
    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    createdAt: Date.now(),
  };
  all.push(newBookmark);
  await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(all));
  return newBookmark;
}

export async function removeBookmark(id: string): Promise<void> {
  const all = await getBookmarks();
  const filtered = all.filter((b) => b.id !== id);
  await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(filtered));
}
