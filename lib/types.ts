export interface Feed {
  id: string;
  title: string;
  rssUrl: string;
  imageUrl: string | null;
  description: string | null;
  author: string | null;
  categoryId: string | null;
  categoryIds?: string[];
  isActive: boolean;
  isFeatured: boolean;
  scheduledPublishAt: string | null;
  lastFetchedAt: string | null;
  createdAt: string;
}

export interface MaggidShiur {
  author: string;
  feeds: Feed[];
  feedCount: number;
  imageUrl?: string | null;
  bio?: string | null;
  profileId?: string;
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
  adminNotes: string | null;
  sourceSheetUrl: string | null;
  createdAt: string;
}

export interface Favorite {
  id: string;
  episodeId: string;
  deviceId: string;
  createdAt: string;
}

export interface PlaybackPosition {
  id: string;
  episodeId: string;
  feedId: string;
  deviceId: string;
  positionMs: number;
  durationMs: number;
  completed: boolean;
  updatedAt: string;
}

export interface ListeningStats {
  totalListens: number;
  uniqueEpisodes: number;
  topFeeds: { feedId: string; title: string; count: number }[];
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
