import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, uniqueIndex, index, jsonb, doublePrecision, customType } from "drizzle-orm/pg-core";

// Postgres tsvector. Drizzle has no native type for it, and it must be declared
// here rather than left undeclared: `drizzle-kit push` runs on every deploy and
// treats a column it doesn't know about as a DROP candidate. Losing search_tsv
// would take the GIN index with it and silently degrade every search to the
// ILIKE fallback until a multi-hour backfill re-ran over 1.65M rows.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const categories = pgTable("categories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const feeds = pgTable("feeds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  rssUrl: text("rss_url").notNull().unique(),
  imageUrl: text("image_url"),
  description: text("description"),
  author: text("author"),
  categoryId: varchar("category_id").references(() => categories.id),
  isActive: boolean("is_active").default(true).notNull(),
  lastFetchedAt: timestamp("last_fetched_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  isFeatured: boolean("is_featured").default(false).notNull(),
  scheduledPublishAt: timestamp("scheduled_publish_at"),
  etag: text("etag"),
  lastModifiedHeader: text("last_modified_header"),
  sourceNetwork: text("source_network"),
  tatSpeakerId: integer("tat_speaker_id"),
  alldafAuthorId: integer("alldaf_author_id"),
  allmishnahAuthorId: integer("allmishnah_author_id"),
  allparshaAuthorId: integer("allparsha_author_id"),
  allhalachaAuthorId: integer("allhalacha_author_id"),
  kolhalashonRavId: integer("kolhalashon_rav_id"),
  torahdownloadsSpeakerId: integer("torahdownloads_speaker_id"),
  // YouTube source. Feeds are playlist-scoped: one ShiurPod feed per YouTube
  // playlist (a channel's uploads playlist — the UU... id — counts as one).
  // rssUrl is yt://playlist/{id}; this column mirrors it like the other
  // source-id columns so a feed can carry YouTube alongside TAT/KH/TD.
  youtubePlaylistId: text("youtube_playlist_id"),
  showInBrowse: boolean("show_in_browse").default(true).notNull(),
  // Search columns. Values are owned by the BEFORE INSERT OR UPDATE trigger in
  // server/search/sql.ts — never write title_fold/author_fold/search_tsv
  // directly. Declared here only so drizzle-kit push knows they exist.
  titleFold: text("title_fold"),
  authorFold: text("author_fold"),
  searchTsv: tsvector("search_tsv"),
  // Denormalised from subscriptions/listens by the refresh job in
  // server/search/popularity.ts, so ranking never joins an aggregate.
  popularity: integer("popularity").default(0).notNull(),
  episodeCount: integer("episode_count").default(0).notNull(),
}, (table) => [
  index("feeds_active_browse_idx").on(table.isActive, table.showInBrowse),
]);

export const episodes = pgTable("episodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  audioUrl: text("audio_url").notNull(),
  duration: text("duration"),
  publishedAt: timestamp("published_at"),
  guid: text("guid").notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  adminNotes: text("admin_notes"),
  sourceSheetUrl: text("source_sheet_url"),
  tatLectureId: integer("tat_lecture_id"),
  kolhalashonFileId: integer("kolhalashon_file_id"),
  torahdownloadsShiurId: integer("torahdownloads_shiur_id"),
  // Set only on episodes promoted from the YouTube review queue. audioUrl for
  // these is the yt://audio/{videoId} placeholder — googlevideo stream URLs
  // expire in ~6h, so the real URL is resolved per playback, never stored.
  youtubeVideoId: text("youtube_video_id"),
  noDownload: boolean("no_download").default(false),
  // Search columns — owned by the trigger, see the note on feeds above.
  titleFold: text("title_fold"),
  searchTsv: tsvector("search_tsv"),
  popularity: integer("popularity").default(0).notNull(),
}, (table) => [
  uniqueIndex("episodes_guid_feed_idx").on(table.guid, table.feedId),
  index("episodes_feed_id_idx").on(table.feedId),
]);

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("subscriptions_device_feed_idx").on(table.deviceId, table.feedId),
  index("subscriptions_feed_id_idx").on(table.feedId),
]);

export const episodeListens = pgTable("episode_listens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  listenedAt: timestamp("listened_at").defaultNow().notNull(),
  durationListenedMs: integer("duration_listened_ms").default(0),
}, (table) => [
  index("episode_listens_device_id_idx").on(table.deviceId),
  index("episode_listens_listened_at_idx").on(table.listenedAt),
  index("episode_listens_episode_id_idx").on(table.episodeId),
]);

export const adminUsers = pgTable("admin_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const favorites = pgTable("favorites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("favorites_episode_device_idx").on(table.episodeId, table.deviceId),
  index("favorites_device_idx").on(table.deviceId),
]);

export const playbackPositions = pgTable("playback_positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  positionMs: integer("position_ms").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  completed: boolean("completed").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("playback_positions_episode_device_idx").on(table.episodeId, table.deviceId),
  index("playback_positions_device_idx").on(table.deviceId),
]);

export const adminNotifications = pgTable("admin_notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  message: text("message").notNull(),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const errorReports = pgTable("error_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id"),
  level: text("level").notNull().default("error"),
  message: text("message").notNull(),
  stack: text("stack"),
  source: text("source"),
  platform: text("platform"),
  appVersion: text("app_version"),
  metadata: text("metadata"),
  resolved: boolean("resolved").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("error_reports_created_idx").on(table.createdAt),
]);

export const pushTokens = pgTable("push_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  token: text("token").notNull().unique(),
  platform: text("platform"),
  provider: text("provider").default("expo"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const feedback = pgTable("feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id"),
  type: text("type").notNull().default("shiur_request"),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  contactInfo: text("contact_info"),
  status: text("status").notNull().default("new"),
  adminNotes: text("admin_notes"),
  deviceLogs: text("device_logs"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const contactMessages = pgTable("contact_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email"),
  message: text("message").notNull(),
  isRead: boolean("is_read").default(false).notNull(),
  status: text("status").default("new").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const feedCategories = pgTable("feed_categories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  categoryId: varchar("category_id").references(() => categories.id, { onDelete: "cascade" }).notNull(),
  autoAssigned: boolean("auto_assigned").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("feed_categories_feed_cat_idx").on(table.feedId, table.categoryId),
]);

export const maggidShiurim = pgTable("maggid_shiurim", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  imageUrl: text("image_url"),
  bio: text("bio"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const apkUploads = pgTable("apk_uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  version: text("version"),
  fileSize: integer("file_size").notNull(),
  fileData: text("file_data"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ApkUpload = typeof apkUploads.$inferSelect;

export const sponsors = pgTable("sponsors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  text: text("text"),
  logoUrl: text("logo_url"),
  linkUrl: text("link_url"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Sponsor = typeof sponsors.$inferSelect;

// YouTube review queue. Ingest NEVER writes straight to `episodes` — every
// video lands here as `pending` and only becomes an episode once an admin
// approves it. Rejected rows are kept forever (not deleted) so the next
// playlist crawl doesn't re-queue something that was already turned down.
export const youtubePending = pgTable("youtube_pending", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  duration: text("duration"),
  durationSeconds: integer("duration_seconds"),
  publishedAt: timestamp("published_at"),
  imageUrl: text("image_url"),
  channelTitle: text("channel_title"),
  // pending | approved | rejected
  status: text("status").default("pending").notNull(),
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: text("reviewed_by"),
  reviewNote: text("review_note"),
  // Set once the MP3 is stored — links back to the episode this became.
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "set null" }),
  // Media pipeline. Approving does NOT create an episode directly: it queues a
  // one-time fetch+transcode, and the episode is created only once the MP3 is
  // on disk. YouTube throttles repeated reads of the same stream hard, so
  // playback can never hit YouTube — we serve our own file.
  // queued | downloading | ready | failed
  mediaStatus: text("media_status"),
  mediaPath: text("media_path"),
  mediaBytes: integer("media_bytes"),
  mediaDurationSec: integer("media_duration_sec"),
  mediaError: text("media_error"),
  mediaAttempts: integer("media_attempts").default(0).notNull(),
  mediaUpdatedAt: timestamp("media_updated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("youtube_pending_feed_video_idx").on(table.feedId, table.videoId),
  index("youtube_pending_status_idx").on(table.status, table.publishedAt),
  index("youtube_pending_feed_status_idx").on(table.feedId, table.status),
  index("youtube_pending_media_status_idx").on(table.mediaStatus),
]);

export type YoutubePending = typeof youtubePending.$inferSelect;

// Keyword rules that decide a video's fate at ingest without a human.
//
// A rule with feedId = null applies to every YouTube feed; otherwise it's
// scoped to that one. Reject always beats approve when both match — the safe
// direction, since a wrongly-rejected shiur is recoverable from the Rejected
// tab but a wrongly-approved one has already reached listeners.
export const youtubeRules = pgTable("youtube_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }),
  // approve | reject
  action: text("action").default("approve").notNull(),
  // contains | regex
  matchType: text("match_type").default("contains").notNull(),
  // title | description | both
  field: text("field").default("title").notNull(),
  pattern: text("pattern").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  note: text("note"),
  matchCount: integer("match_count").default(0).notNull(),
  lastMatchedAt: timestamp("last_matched_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("youtube_rules_feed_idx").on(table.feedId, table.enabled),
]);

export type YoutubeRule = typeof youtubeRules.$inferSelect;

export const insertFeedSchema = createInsertSchema(feeds).pick({
  title: true,
  rssUrl: true,
  imageUrl: true,
  description: true,
  author: true,
  categoryId: true,
  sourceNetwork: true,
  tatSpeakerId: true,
  kolhalashonRavId: true,
  torahdownloadsSpeakerId: true,
  youtubePlaylistId: true,
  showInBrowse: true,
});

export const insertCategorySchema = createInsertSchema(categories).pick({
  name: true,
  slug: true,
});

export const insertSubscriptionSchema = z.object({
  deviceId: z.string(),
  feedId: z.string(),
});

export const insertFavoriteSchema = z.object({
  episodeId: z.string(),
  deviceId: z.string(),
});

export type Feed = typeof feeds.$inferSelect;
export type InsertFeed = z.infer<typeof insertFeedSchema>;
export type Category = typeof categories.$inferSelect;
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type Episode = typeof episodes.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type AdminUser = typeof adminUsers.$inferSelect;
export type Favorite = typeof favorites.$inferSelect;
export type PlaybackPosition = typeof playbackPositions.$inferSelect;
export type AdminNotification = typeof adminNotifications.$inferSelect;
export type ErrorReport = typeof errorReports.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
export type ContactMessage = typeof contactMessages.$inferSelect;
export type FeedCategory = typeof feedCategories.$inferSelect;
export type MaggidShiur = typeof maggidShiurim.$inferSelect;
export type InsertMaggidShiur = typeof maggidShiurim.$inferInsert;

export const notificationPreferences = pgTable("notification_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  muted: boolean("muted").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("notification_prefs_device_feed_idx").on(table.deviceId, table.feedId),
]);

export type NotificationPreference = typeof notificationPreferences.$inferSelect;

export const announcements = pgTable("announcements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  body: text("body").notNull(),
  imageUrl: text("image_url"),
  actionLabel: text("action_label"),
  actionUrl: text("action_url"),
  targetType: text("target_type").notNull().default("all"), // "all" | "feed_subscribers" | "device"
  targetValue: text("target_value"), // null for "all", feedId for "feed_subscribers", deviceId for "device"
  frequency: text("frequency").notNull().default("once"), // "once" | "every_open" | "until_dismissed"
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const announcementDismissals = pgTable("announcement_dismissals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  announcementId: varchar("announcement_id").references(() => announcements.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id").notNull(),
  dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("announcement_dismissals_ann_device_idx").on(table.announcementId, table.deviceId),
]);

export type Announcement = typeof announcements.$inferSelect;
export type AnnouncementDismissal = typeof announcementDismissals.$inferSelect;

export const queueItems = pgTable("queue_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "cascade" }).notNull(),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  position: integer("position").notNull().default(0),
  addedAt: timestamp("added_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("queue_items_device_episode_idx").on(table.deviceId, table.episodeId),
]);

export type QueueItem = typeof queueItems.$inferSelect;

export const notificationTaps = pgTable("notification_taps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  notificationType: text("notification_type"), // "new_episode" | "custom" | "daily_reminder" | null
  episodeId: varchar("episode_id").references(() => episodes.id, { onDelete: "set null" }),
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "set null" }),
  tappedAt: timestamp("tapped_at").defaultNow().notNull(),
});

export type NotificationTap = typeof notificationTaps.$inferSelect;

export const feedMergeHistory = pgTable("feed_merge_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  targetFeedId: varchar("target_feed_id").references(() => feeds.id, { onDelete: "cascade" }).notNull(),
  sourceFeedTitle: text("source_feed_title").notNull(),
  sourceFeedAuthor: text("source_feed_author"),
  sourceFeedRssUrl: text("source_feed_rss_url"),
  episodesMoved: integer("episodes_moved").default(0).notNull(),
  subscriptionsMoved: integer("subscriptions_moved").default(0).notNull(),
  mergedAt: timestamp("merged_at").defaultNow().notNull(),
});

export type FeedMergeHistory = typeof feedMergeHistory.$inferSelect;

export const appConfig = pgTable("app_config", {
  key: varchar("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AppConfig = typeof appConfig.$inferSelect;

export const deviceProfiles = pgTable("device_profiles", {
  deviceId: text("device_id").primaryKey(),
  platform: text("platform"),
  osVersion: text("os_version"),
  deviceModel: text("device_model"),
  deviceBrand: text("device_brand"),
  screenWidth: integer("screen_width"),
  screenHeight: integer("screen_height"),
  appVersion: text("app_version"),
  locale: text("locale"),
  timezone: text("timezone"),
  country: text("country"),
  city: text("city"),
  ipAddress: text("ip_address"),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DeviceProfile = typeof deviceProfiles.$inferSelect;

export const conversations = pgTable("conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id").notNull(),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("open"), // "open" | "closed"
  feedbackId: varchar("feedback_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Conversation = typeof conversations.$inferSelect;

export const conversationMessages = pgTable("conversation_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").references(() => conversations.id, { onDelete: "cascade" }).notNull(),
  sender: text("sender").notNull(), // "user" | "admin"
  message: text("message").notNull(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ConversationMessage = typeof conversationMessages.$inferSelect;

export const pageViews = pgTable("page_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  path: text("path").notNull(),
  referrer: text("referrer"),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  country: text("country"),
  city: text("city"),
  deviceType: text("device_type"), // "mobile" | "desktop" | "tablet"
  sessionId: text("session_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("page_views_created_at_idx").on(table.createdAt),
  index("page_views_path_idx").on(table.path),
]);

export type PageView = typeof pageViews.$inferSelect;

// YTC unlocks — one row per successful tryUnlock() in lib/ytc/unlock.ts.
// Used by the ShiurPod admin dashboard to show total unlocks + unique
// device count, so the admin can answer "how many users have unlocked
// the YTC section?" without scraping logs. We keep it deliberately
// shallow (no userId / email — that's YTC's private project; we just
// count the unlock event itself from the client device).
export const ytcUnlocks = pgTable("ytc_unlocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id"),         // optional — sent if available
  platform: text("platform"),          // "ios" | "android" | "web"
  appVersion: text("app_version"),     // e.g. "2.0.0"
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("ytc_unlocks_created_at_idx").on(table.createdAt),
  index("ytc_unlocks_device_id_idx").on(table.deviceId),
]);

export type YtcUnlock = typeof ytcUnlocks.$inferSelect;

// ── Telemetry overhaul (crashctl-style issues + perf metrics) ──
//
// `issues` is the first-class grouping. Every JS error, render crash, or
// native crash hashes to a stable `fingerprint` (sha1 of source + normalized
// message + top stack frame). Lifecycle:
//
//   active → resolve (with version+note) → regressed (auto) → active again
//   active → archive → archived (won't auto-reopen)
//
// `issue_events` is the per-occurrence log. Cheap to write, capped retention.
// `app_metrics` is the perf telemetry stream — separate so high-volume
// playback/cold-start/screen-mount events don't pollute the error feed or
// the spike-alert detector.
export const issues = pgTable("issues", {
  fingerprint: text("fingerprint").primaryKey(),
  title: text("title").notNull(),
  exception: text("exception"),
  source: text("source"),
  severity: text("severity").notNull().default("nonfatal"), // fatal | nonfatal | warn
  status: text("status").notNull().default("active"),       // active | resolved | regressed | archived
  firstSeen: timestamp("first_seen").defaultNow().notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
  count: integer("count").notNull().default(0),
  uniqueDeviceCount: integer("unique_device_count").notNull().default(0),
  platforms: text("platforms").array().notNull().default(sql`'{}'::text[]`),
  appVersions: text("app_versions").array().notNull().default(sql`'{}'::text[]`),
  topStackFrame: text("top_stack_frame"),
  topMessage: text("top_message"),
  resolvedAt: timestamp("resolved_at"),
  resolvedAtVersion: text("resolved_at_version"),
  // OTA-aware auto-reopen. When the operator resolves an issue we snapshot
  // the current production OTA's group ID + publish time. A future event
  // whose metadata.ota.createdAt is strictly greater than this value flips
  // status to 'regressed' even if appVersion is unchanged — because EAS
  // updates don't bump appVersion, so the version-only comparison would
  // miss every OTA-shipped fix.
  resolvedAtUpdateId: text("resolved_at_update_id"),
  resolvedAtUpdateCreatedAt: timestamp("resolved_at_update_created_at"),
  resolvedNote: text("resolved_note"),
  resolvedBy: text("resolved_by"),
  archivedAt: timestamp("archived_at"),
}, (table) => [
  index("issues_status_last_seen_idx").on(table.status, table.lastSeen),
  index("issues_last_seen_idx").on(table.lastSeen),
  index("issues_severity_idx").on(table.severity),
]);

export const issueEvents = pgTable("issue_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fingerprint: text("fingerprint").notNull(),
  deviceId: text("device_id"),
  platform: text("platform"),
  appVersion: text("app_version"),
  message: text("message").notNull(),
  stack: text("stack"),
  breadcrumbs: jsonb("breadcrumbs"),
  source: text("source"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("issue_events_fp_created_idx").on(table.fingerprint, table.createdAt),
  index("issue_events_created_idx").on(table.createdAt),
]);

export const appMetrics = pgTable("app_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  deviceId: text("device_id"),
  platform: text("platform"),
  appVersion: text("app_version"),
  kind: text("kind").notNull(),
  valueNum: doublePrecision("value_num"),
  valueText: text("value_text"),
  episodeId: text("episode_id"),
  feedId: text("feed_id"),
  networkType: text("network_type"),
  cdnHost: text("cdn_host"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("app_metrics_kind_created_idx").on(table.kind, table.createdAt),
  index("app_metrics_created_idx").on(table.createdAt),
]);

export type Issue = typeof issues.$inferSelect;
export type IssueEvent = typeof issueEvents.$inferSelect;
export type AppMetric = typeof appMetrics.$inferSelect;

// ─── Contributor program ──────────────────────────────────────────────────
// Rabbanim publish THROUGH us: apply -> approved -> upload -> we generate a
// spec-compliant podcast feed at /feed/{slug}.xml, submitted once to Apple and
// Spotify. Audio lives in Cloudflare R2. The catalog mirror lives in
// feeds/episodes like any other show, so the app needs no special case.
//
// Two rules hold across every table here:
//   1. NO new columns on `episodes` or `feeds`. The search triggers own
//      title_fold/search_tsv/popularity there, and the tsvector was backfilled
//      over 1.65M rows — it must not be disturbed. The only link into the
//      catalog is contributorEpisodes.catalogEpisodeId.
//   2. No array columns. Binding a JS array to a Postgres text[] through
//      drizzle fails with "cannot cast type record to text[]"; topics live in
//      a join table instead, which also gives an indexed browse-by-topic.

export const contributorApplications = pgTable("contributor_applications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  organization: text("organization"),
  proposedTitle: text("proposed_title").notNull(),
  proposedDescription: text("proposed_description").notNull(),
  language: text("language").default("en").notNull(),        // en | he | yi
  bio: text("bio"),
  sampleAudioKey: text("sample_audio_key"),                  // R2 key if uploaded
  sampleAudioUrl: text("sample_audio_url"),                  // if a link was pasted
  status: text("status").default("pending").notNull(),       // pending | approved | rejected
  reviewNotes: text("review_notes"),
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: text("reviewed_by"),
  contributorId: varchar("contributor_id"),                  // set on approval
  // Kept for abuse triage — this is the first public write endpoint with no
  // deviceId to correlate on.
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("contributor_applications_status_idx").on(table.status, table.createdAt),
  index("contributor_applications_email_idx").on(table.email),
]);

export const contributors = pgTable("contributors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  displayName: text("display_name").notNull(),
  contactEmail: text("contact_email").notNull().unique(),    // the rav's REAL address
  passwordHash: text("password_hash"),                       // null until the setup link is used
  status: text("status").default("active").notNull(),        // active | suspended
  applicationId: varchar("application_id")
    .references(() => contributorApplications.id, { onDelete: "set null" }),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Opaque bearer tokens. Only the SHA-256 is stored, so a database leak does not
// hand out live sessions — deliberately unlike admin auth, where the token IS
// base64(user:pass) and is kept in localStorage indefinitely.
// `purpose` folds login, first-time setup and password reset into one table.
export const contributorSessions = pgTable("contributor_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  contributorId: varchar("contributor_id")
    .references(() => contributors.id, { onDelete: "cascade" }).notNull(),
  purpose: text("purpose").default("session").notNull(),     // session | setup | reset
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),                              // single-use for setup/reset
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("contributor_sessions_contributor_idx").on(table.contributorId),
  index("contributor_sessions_expires_idx").on(table.expiresAt),
]);

export const contributorShows = pgTable("contributor_shows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contributorId: varchar("contributor_id")
    .references(() => contributors.id, { onDelete: "cascade" }).notNull(),
  // Catalog mirror, set when the show goes live. rssUrl there is cp://show/{id}.
  feedId: varchar("feed_id").references(() => feeds.id, { onDelete: "set null" }),
  // IMMUTABLE once live — it's baked into every published enclosure and into
  // the feed URL submitted to Apple and Spotify.
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  language: text("language").default("en").notNull(),        // en | he | yi
  author: text("author").notNull(),                          // itunes:author; mirrors feeds.author
  ownerName: text("owner_name").notNull(),                   // itunes:owner name
  // ALWAYS show-{slug}@shiurpod.com on our catch-all, never the rav's address:
  // this is where Apple and Spotify send the directory claim code, and the
  // operator has to be able to complete the claim without bothering him.
  ownerEmail: text("owner_email").notNull(),
  copyright: text("copyright"),
  link: text("link"),                                        // channel <link>
  artworkKey: text("artwork_key"),
  artworkWidth: integer("artwork_width"),
  artworkHeight: integer("artwork_height"),
  categoryId: varchar("category_id").references(() => categories.id),
  itunesCategory: text("itunes_category").default("Religion & Spirituality").notNull(),
  itunesSubcategory: text("itunes_subcategory").default("Judaism").notNull(),
  itunesType: text("itunes_type").default("episodic").notNull(),  // episodic | serial
  explicit: boolean("explicit").default(false).notNull(),
  // Moderation. ON by default for new contributors, per spec — can be turned
  // off once a rav is established.
  reviewRequired: boolean("review_required").default(true).notNull(),
  status: text("status").default("draft").notNull(),         // draft | live | suspended
  // Rendered-feed cache. In the row rather than an in-process Map so it
  // survives restarts and stays correct if this is ever scaled past one replica.
  feedXml: text("feed_xml"),
  feedEtag: text("feed_etag"),
  feedBuiltAt: timestamp("feed_built_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("contributor_shows_contributor_idx").on(table.contributorId),
  index("contributor_shows_status_idx").on(table.status),
]);

export const contributorEpisodes = pgTable("contributor_episodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  showId: varchar("show_id")
    .references(() => contributorShows.id, { onDelete: "cascade" }).notNull(),
  // The RSS <guid>. Minted by the column default at row creation and NEVER
  // rewritten — if it changes, every subscriber re-downloads the shiur as new.
  // Enforced by the schema rather than by discipline.
  guid: varchar("guid").notNull().unique().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),                          // HTML allowed
  audioKey: text("audio_key"),                               // R2 key; null until ready
  // EXACT byte count, taken from an R2 HEAD after upload — never estimated.
  // Apple rejects feeds whose enclosure length is wrong.
  byteSize: integer("byte_size"),
  durationSeconds: integer("duration_seconds"),
  pubDate: timestamp("pub_date"),
  episodeNumber: integer("episode_number"),
  seasonNumber: integer("season_number"),
  artworkKey: text("artwork_key"),
  explicit: boolean("explicit").default(false).notNull(),
  // draft | processing | failed | pending_review | scheduled | published | unpublished
  status: text("status").default("draft").notNull(),
  publishedAt: timestamp("published_at"),

  // Torah metadata — optional and additive, NOT emitted in the RSS. Surfaced in
  // our own UI so contributor shows are browsable by it. Free-form tags live in
  // contributorEpisodeTopics.
  seriesName: text("series_name"),
  masechta: text("masechta"),
  daf: text("daf"),
  parsha: text("parsha"),

  // Transcode job. Same column shape as youtube_pending.media_* so the worker
  // reuses the FOR UPDATE SKIP LOCKED claim pattern verbatim.
  uploadKey: text("upload_key"),                             // raw upload; deleted after transcode
  uploadBytes: integer("upload_bytes"),
  mediaStatus: text("media_status"),                         // queued | processing | ready | failed
  mediaError: text("media_error"),
  mediaAttempts: integer("media_attempts").default(0).notNull(),
  mediaUpdatedAt: timestamp("media_updated_at"),

  // The catalog mirror row, so unpublish can remove it directly — the thing
  // RSS self-ingestion structurally cannot do.
  catalogEpisodeId: varchar("catalog_episode_id")
    .references(() => episodes.id, { onDelete: "set null" }),

  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: text("reviewed_by"),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("contributor_episodes_show_status_idx").on(table.showId, table.status, table.pubDate),
  index("contributor_episodes_media_status_idx").on(table.mediaStatus),
  index("contributor_episodes_scheduled_idx").on(table.status, table.pubDate),
]);

// A join table rather than text[]: drizzle cannot bind a JS array to a text[]
// parameter, and this gives a plain btree for browse-by-topic.
export const contributorEpisodeTopics = pgTable("contributor_episode_topics", {
  episodeId: varchar("episode_id")
    .references(() => contributorEpisodes.id, { onDelete: "cascade" }).notNull(),
  topic: text("topic").notNull(),
}, (table) => [
  uniqueIndex("contributor_episode_topics_ep_topic_idx").on(table.episodeId, table.topic),
  index("contributor_episode_topics_topic_idx").on(table.topic),
]);

// Directory submission is manual per show (Spotify has no publishing API), so
// this is a tracked checklist rather than an automated pipeline.
export const contributorDirectorySubmissions = pgTable("contributor_directory_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  showId: varchar("show_id")
    .references(() => contributorShows.id, { onDelete: "cascade" }).notNull(),
  platform: text("platform").notNull(),                      // apple | spotify | amazon | podcastindex
  status: text("status").default("not_submitted").notNull(), // not_submitted | submitted | live | rejected
  submittedAt: timestamp("submitted_at"),
  showUrl: text("show_url"),
  note: text("note"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("contributor_directory_show_platform_idx").on(table.showId, table.platform),
]);

export type ContributorApplication = typeof contributorApplications.$inferSelect;
export type Contributor = typeof contributors.$inferSelect;
export type ContributorSession = typeof contributorSessions.$inferSelect;
export type ContributorShow = typeof contributorShows.$inferSelect;
export type ContributorEpisode = typeof contributorEpisodes.$inferSelect;
export type ContributorEpisodeTopic = typeof contributorEpisodeTopics.$inferSelect;
export type ContributorDirectorySubmission = typeof contributorDirectorySubmissions.$inferSelect;
