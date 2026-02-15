export interface Feed {
  id: string;
  title: string;
  rssUrl: string;
  imageUrl: string | null;
  description: string | null;
  author: string | null;
  categoryId: string | null;
  isActive: boolean;
  lastFetchedAt: string | null;
  createdAt: string;
}

export interface Episode {
  id: string;
  feedId: string;
  title: string;
  description: string | null;
  audioUrl: string;
  duration: string | null;
  publishedAt: string | null;
  guid: string;
  imageUrl: string | null;
  createdAt: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Subscription {
  id: string;
  deviceId: string;
  feedId: string;
  createdAt: string;
}

export interface DownloadedEpisode extends Episode {
  localUri: string;
  feedTitle: string;
  feedImageUrl: string | null;
  downloadedAt: string;
}
