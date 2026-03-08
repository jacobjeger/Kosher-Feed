import axios from "axios";
import * as storage from "./storage";
import { sendNewEpisodePushes } from "./push";

const TAT_BASE_URL = "https://api.torahanytime.com";
const TAT_PROJECT_ID = 1;
const TAT_SPEAKER_PHOTO_BASE = "https://torahanytime-files.sfo2.digitaloceanspaces.com/assets/flash/speakers/";

// --- Types ---

export interface TATSpeaker {
  id: number;
  name_first: string;
  name_last: string;
  title_text: string;
  title_short: string;
  slug: string;
  photo: string;
  desc: string;
  female: boolean;
  is_guest: boolean;
  lecture_count: number;
  no_download: boolean;
  display_active: boolean;
  view_female_level: number;
}

export interface TATLecture {
  id: number;
  title: string;
  slug: string;
  title_rtl: boolean;
  duration: number;
  date_recorded: string;
  date_created: string;
  speaker: number;
  speaker_name_first: string;
  speaker_name_last: string;
  language_name: string;
  ladies: boolean;
  is_short: boolean;
  private: boolean;
  no_download: boolean | null;
  display_active: boolean;
  categories: { id: number; name: string; english_name: string | null }[];
  subcategories: { id: number; name: string; english_name: string | null }[];
  thumbnail_url: string;
  mp3_url: string;
  mp4_url: string;
  m3u8_url: string;
  published_by_name: string;
}

// --- API Client ---

async function tatGet(path: string, params: Record<string, any> = {}): Promise<any> {
  const res = await axios.get(`${TAT_BASE_URL}${path}`, {
    params,
    timeout: 30000,
    headers: { "User-Agent": "ShiurPod/1.0" },
  });
  return res.data;
}

export async function fetchAllSpeakers(): Promise<TATSpeaker[]> {
  const allSpeakers: TATSpeaker[] = [];
  const limit = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const data = await tatGet("/search/speakers/alphabet", {
      "include-guest": true,
      limit,
      offset,
    });

    total = data.totalSpeakers || 0;

    // Speakers are grouped by letter
    const speakers = data.speakers;
    if (speakers && typeof speakers === "object") {
      for (const letter of Object.keys(speakers)) {
        for (const speaker of speakers[letter]) {
          allSpeakers.push(speaker);
        }
      }
    }

    offset += limit;
    // Small delay to be respectful
    if (offset < total) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allSpeakers;
}

export async function fetchSpeakerLectures(
  speakerId: number,
  limit: number = 150,
  offset: number = 0,
): Promise<{ lectures: TATLecture[]; total?: number }> {
  const data = await tatGet(`/speakers/${speakerId}/lectures`, {
    project_id: TAT_PROJECT_ID,
    limit,
    offset,
  });

  const lectures: TATLecture[] = data.lecture || data.lectures || [];
  return { lectures, total: data.total };
}

export async function fetchAllSpeakerLectures(speakerId: number): Promise<TATLecture[]> {
  const allLectures: TATLecture[] = [];
  const limit = 150;
  let offset = 0;

  while (true) {
    const { lectures } = await fetchSpeakerLectures(speakerId, limit, offset);
    allLectures.push(...lectures);

    if (lectures.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 200));
  }

  return allLectures;
}

// --- Helpers ---

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildSpeakerName(speaker: TATSpeaker): string {
  const title = speaker.title_short?.trim() || "";
  const first = speaker.name_first?.trim() || "";
  const last = speaker.name_last?.trim() || "";
  return [title, first, last].filter(Boolean).join(" ");
}

function buildSpeakerPhotoUrl(speaker: TATSpeaker): string | null {
  if (!speaker.photo) return null;
  return `${TAT_SPEAKER_PHOTO_BASE}${speaker.photo}`;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/\b(rabbi|rav|r\.|r'|rebbetzin|harav|hagaon|moreinu|dr\.?|mrs?\.?)\b/gi, "")
    .replace(/\b[a-z]\.\s*/gi, "") // Remove middle initials like "J."
    .replace(/\s+/g, " ")
    .trim();
}

export function mapTATLectureToEpisodeData(lecture: TATLecture, feedId: string) {
  return {
    feedId,
    title: lecture.title,
    description: [
      lecture.language_name,
      ...(lecture.categories || []).map(c => c.english_name || c.name),
      ...(lecture.subcategories || []).map(c => c.english_name || c.name),
    ].filter(Boolean).join(" · ") || null,
    audioUrl: lecture.mp3_url,
    duration: formatDuration(lecture.duration),
    publishedAt: lecture.date_recorded ? new Date(lecture.date_recorded) : null,
    guid: `tat-${lecture.id}`,
    imageUrl: lecture.thumbnail_url || null,
    tatLectureId: lecture.id,
    noDownload: lecture.no_download || false,
  };
}

// --- Sync Logic ---

export async function syncTATSpeakers(): Promise<{ created: number; linked: number; total: number }> {
  console.log("TAT Sync: fetching all speakers...");
  const speakers = await fetchAllSpeakers();
  console.log(`TAT Sync: found ${speakers.length} speakers`);

  // Get all existing feeds for matching
  const allFeeds = await storage.getAllFeeds();
  const existingTATFeeds = new Map<number, string>(); // tatSpeakerId -> feedId
  for (const feed of allFeeds) {
    if (feed.tatSpeakerId) {
      existingTATFeeds.set(feed.tatSpeakerId, feed.id);
    }
  }

  // Build normalized name -> feed map for matching (check both author and title)
  const feedsByNormalizedName = new Map<string, typeof allFeeds[0]>();
  for (const feed of allFeeds) {
    if (feed.tatSpeakerId) continue;
    if (feed.author) {
      feedsByNormalizedName.set(normalizeName(feed.author), feed);
    }
    if (feed.title) {
      const normalizedTitle = normalizeName(feed.title);
      if (!feedsByNormalizedName.has(normalizedTitle)) {
        feedsByNormalizedName.set(normalizedTitle, feed);
      }
    }
  }

  let created = 0;
  let linked = 0;

  for (const speaker of speakers) {
    if (!speaker.display_active) continue;
    if (speaker.lecture_count === 0) continue;
    if (speaker.female) continue;

    // Already synced
    if (existingTATFeeds.has(speaker.id)) continue;

    const speakerName = buildSpeakerName(speaker);
    const normalizedSpeakerName = normalizeName(speakerName);
    const photoUrl = buildSpeakerPhotoUrl(speaker);

    // Try to match existing feed by name (exact normalized match, then last-name match)
    let matchedFeed = feedsByNormalizedName.get(normalizedSpeakerName);
    if (!matchedFeed && speaker.name_last) {
      // Try matching by last name + first name (without title)
      const lastFirst = normalizeName(`${speaker.name_first} ${speaker.name_last}`);
      matchedFeed = feedsByNormalizedName.get(lastFirst);
    }

    if (matchedFeed) {
      // Link existing feed to this TAT speaker
      await storage.updateFeed(matchedFeed.id, {
        tatSpeakerId: speaker.id,
        sourceNetwork: matchedFeed.sourceNetwork || "Torah Anytime",
      } as any);
      linked++;
      console.log(`TAT Sync: linked "${speakerName}" to existing feed "${matchedFeed.title}"`);
    } else {
      // Create new feed for this TAT speaker
      try {
        await storage.createFeed({
          title: speakerName,
          rssUrl: `tat://speaker/${speaker.id}`,
          imageUrl: photoUrl,
          description: speaker.desc || null,
          author: speakerName,
          categoryId: null,
          sourceNetwork: "Torah Anytime",
          tatSpeakerId: speaker.id,
        });
        created++;
      } catch (e: any) {
        // Skip if duplicate rssUrl (already exists)
        if (!e.message?.includes("unique") && !e.message?.includes("duplicate")) {
          console.error(`TAT Sync: failed to create feed for "${speakerName}":`, e.message);
        }
      }
    }
  }

  console.log(`TAT Sync complete: ${created} created, ${linked} linked, ${speakers.length} total speakers`);
  return { created, linked, total: speakers.length };
}

// --- Episode Refresh for TAT Feeds ---

export async function refreshTATFeedEpisodes(feed: { id: string; title: string; tatSpeakerId: number }): Promise<{ newEpisodes: number }> {
  const lectures = await fetchAllSpeakerLectures(feed.tatSpeakerId);

  // Filter out private and inactive lectures
  const validLectures = lectures.filter(l => !l.private && l.display_active);

  const episodeData = validLectures.map(l => mapTATLectureToEpisodeData(l, feed.id));
  const inserted = await storage.upsertTATEpisodes(feed.id, episodeData);

  await storage.updateFeed(feed.id, { lastFetchedAt: new Date() });

  if (inserted.length > 0) {
    console.log(`TAT refresh: ${feed.title} — ${inserted.length} new episode(s)`);
    for (const ep of inserted.slice(0, 3)) {
      sendNewEpisodePushes(feed.id, { title: ep.title, id: ep.id }, feed.title).catch(() => {});
    }
  }

  return { newEpisodes: inserted.length };
}
