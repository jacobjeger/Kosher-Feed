# ShiurPod

## Overview

ShiurPod is a mobile-first shiur (Torah lecture) listening application built with Expo (React Native) on the frontend and Express.js on the backend. It allows users to browse, follow, and listen to curated podcast/shiur feeds. The app includes audio playback with position saving, episode downloads for offline listening, auto-download on WiFi, new episode notifications, device-based subscriptions (no user accounts), and an admin panel for managing feeds and categories. The backend serves as both an API server and a static file server for the web build.

**Terminology**: Content is referred to as "shiurim" (plural) / "shiur" (singular) throughout the app — NOT podcasts or shows.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend (Expo / React Native)
- **Framework**: Expo SDK 54 with React Native 0.81, using expo-router for file-based routing
- **Routing structure**: Tab-based navigation with 4 tabs (Home, Following, Downloads, Settings), a modal player screen, a queue screen, a podcast detail screen at `podcast/[id]`, and a Maggid Shiur (speaker) detail screen at `maggid-shiur/[author]`
- **State management**: React Context for audio playback (`AudioPlayerContext`), downloads (`DownloadsContext`), user settings (`SettingsContext`), favorites (`FavoritesContext`), and played episodes (`PlayedEpisodesContext`); TanStack React Query for server state
- **Played episodes tracking**: `PlayedEpisodesContext` stores played episode IDs in AsyncStorage (`@shiurpod_played_episodes`), auto-marks episodes when they finish, shows progress bars on episode cards (green=played, blue=in-progress)
- **Continuous playback**: When enabled in settings, auto-plays next episode from same feed when current episode ends and queue is empty
- **Queue management**: Queue screen at `app/queue.tsx` with up/down reorder buttons, remove items, clear queue, and play from queue. Queue state managed in AudioPlayerContext with `refreshQueue` for AsyncStorage sync
- **Episode filtering**: Podcast detail screen has filter chips (All/Unplayed/Started/Saved) alongside sort options (Newest/Oldest)
- **Long-press actions**: Context menu on episodes (native Alert) for quick access to queue, mark played, favorites, and download actions
- **Pull-to-refresh**: Podcast detail screen supports pull-to-refresh to reload episodes and feed data
- **Deep link sharing**: Player share generates a web share URL (`/share/episode/:id?t=timestamp`) with OG meta tags for social previews, an audio player fallback, and a deep link button to open directly in the app. `DeepLinkHandler` component in `_layout.tsx` handles incoming `shiurpod://episode/:id` links.
- **Push notifications**: Expo push tokens registered on app start via `lib/push-notifications.ts`, stored in `push_tokens` table. Server sends push notifications via `expo-server-sdk` (`server/push.ts`) when new episodes are detected during RSS feed refresh. Android channel set to MAX importance for heads-up banners.
- **Storage management**: Dedicated screen at `app/storage.tsx` accessible from Settings > Downloaded Episodes. Shows total download size, per-feed breakdowns with episode lists, and options to clear individual episodes, all episodes for a feed, or all downloads at once.
- **Animated transitions**: MiniPlayer uses react-native-reanimated FadeInDown entrance animation (skipped on web)
- **Audio playback**: Dual engine — `expo-audio` (`createAudioPlayer`) for native (Android/iOS) with background playback, lock-screen controls via `setActiveForLockScreen()`/`updateLockScreenMetadata()`, and media session integration; HTML5 Audio for web. Unified context API (`AudioPlayerContext`) provides play/pause/seek/skip/rate controls. Saves playback position to AsyncStorage every 30 seconds and on pause/stop, resuming from saved position on replay. Server-side position sync for cross-device resume. Background audio enabled via expo-audio plugin in app.json with `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permission on Android and `UIBackgroundModes: ["audio"]` on iOS.
- **Offline support**: Episode downloads managed via `expo-file-system` with progress tracking, persisted to AsyncStorage. Auto-download on WiFi for followed shiurim with configurable per-shiur episode storage limits. Batch download support for downloading multiple episodes at once.
- **Notifications**: Local browser notifications (web) for new episodes from followed shiurim. Tracks seen episodes in AsyncStorage to avoid duplicate alerts.
- **Background sync**: `BackgroundSync` component polls for new episodes every 5 minutes in foreground. On native, `expo-background-task` + `expo-task-manager` run a background task (`lib/background-tasks.ts`) every 15 minutes for notification checks even when the app is closed. Download progress throttled to 1s intervals with 2% minimum change to prevent UI freezing on low-end devices.
- **Device identification**: Anonymous device IDs generated with `expo-crypto` and stored in AsyncStorage — no user accounts required for subscriptions
- **Styling**: Plain React Native StyleSheet with a custom color system supporting light/dark themes (defined in `constants/colors.ts`)
- **Haptics**: Optional haptic feedback on iOS/Android via `expo-haptics`, gracefully skipped on web

### Backend (Express.js)
- **Server**: Express 5 running on port 5000 (configured in `server/index.ts`)
- **API pattern**: RESTful JSON API under `/api/` prefix
- **Key endpoints**:
  - `GET /api/feeds` — list all feeds (includes `categoryIds[]` from junction table)
  - `GET /api/feeds/featured` — list featured feeds
  - `GET /api/feeds/maggid-shiur` — feeds grouped by author/speaker
  - `GET /api/feeds/category/:categoryId` — feeds by category (merges legacy + junction table)
  - `GET /api/feeds/:id/episodes` — episodes for a feed (supports sort=newest|oldest)
  - `GET /api/categories` — list categories
  - `POST/DELETE /api/subscriptions` — manage device subscriptions
  - `GET /api/subscriptions/:deviceId/feeds` — get subscribed feeds
  - `GET/POST/DELETE /api/favorites` — manage favorite episodes
  - `POST /api/playback-positions` — sync playback position to server
  - `GET /api/stats/:deviceId` — listening statistics
  - `GET /api/episodes/search` — global episode search
  - `GET /api/episodes/trending` — popular/trending episodes
  - `POST /api/push-token` — register Expo push token for device
  - `GET /api/share/episode/:id` — get episode + feed data for sharing
  - `GET /share/episode/:id` — web share page with OG tags, audio player, deep link
  - Admin CRUD endpoints for feeds/categories (Basic auth protected)
- **RSS parsing**: `rss-parser` library fetches and parses podcast RSS feeds, extracting episode metadata
- **Admin panel**: Server-rendered HTML admin interface at `/admin` for managing feeds, categories, and speaker (Maggid Shiur) profiles
- **Admin auth**: Simple Basic auth with bcrypt-hashed passwords, default credentials `admin/admin123`
- **CORS**: Dynamic origin allowlist based on Replit environment variables, plus localhost support for dev
- **Performance**: gzip compression via `compression` middleware; Cache-Control headers on read endpoints (feeds/categories 60s, episodes 30s)

### Database (PostgreSQL + Drizzle ORM)
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema** (defined in `shared/schema.ts`):
  - `categories` — podcast categories (id, name, slug)
  - `feeds` — podcast feeds (id, title, rssUrl, imageUrl, description, author, categoryId, isActive, isFeatured, lastFetchedAt)
  - `feedCategories` — many-to-many junction table linking feeds to multiple categories (feedId, categoryId)
  - `episodes` — individual episodes (id, feedId, title, description, audioUrl, duration, publishedAt, guid, imageUrl, sourceSheetUrl, adminNotes) with unique index on (guid, feedId)
  - `subscriptions` — device-feed subscriptions with unique index on (deviceId, feedId)
  - `admin_users` — admin credentials for the management panel
  - `favorites` — favorite episodes per device with unique index on (episodeId, deviceId)
  - `playbackPositions` — server-synced playback positions per device/episode with upsert on (episodeId, deviceId)
  - `adminNotifications` — admin notification campaigns
  - `push_tokens` — Expo push notification tokens per device
  - `episodeListens` — episode listen tracking for trending/analytics
  - `maggid_shiurim` — customizable speaker profiles (id, name, imageUrl, bio) linked to feeds by author name
- **Migrations**: Managed via `drizzle-kit push` (schema push approach, not file-based migrations)
- **Connection**: `pg` Pool with `DATABASE_URL` environment variable

### Build & Deployment
- **Development**: Two processes run simultaneously — `expo:dev` for the Expo dev server and `server:dev` for the Express API (via tsx)
- **Production build**: Custom build script (`scripts/build.js`) creates a static web export, then Express serves it alongside the API. Server is bundled with esbuild.
- **Shared code**: The `shared/` directory contains schema and types used by both frontend and backend, with TypeScript path aliases (`@shared/*`)

## External Dependencies

### Required Services
- **PostgreSQL**: Primary database, connected via `DATABASE_URL` environment variable. Must be provisioned before the app can start.

### Key NPM Packages
- **expo** (~54.0.27) — React Native framework and build tooling
- **expo-router** (~6.0.17) — File-based routing
- **expo-audio** (~1.1.1) — Audio playback on native platforms (replaced deprecated expo-av)
- **expo-file-system** — Download and store episodes locally
- **expo-image** — Optimized image loading
- **@tanstack/react-query** — Server state management and caching
- **drizzle-orm** + **drizzle-kit** — Database ORM and schema management
- **pg** — PostgreSQL client
- **express** (v5) — HTTP server
- **rss-parser** — RSS feed parsing for podcast metadata
- **bcrypt** — Password hashing for admin auth
- **react-native-reanimated** — Animations (mini player transitions)
- **react-native-gesture-handler** — Touch gesture handling
- **react-native-keyboard-controller** — Keyboard-aware scrolling
- **@react-native-async-storage/async-storage** — Persistent key-value storage
- **@react-native-community/slider** — Audio seek slider
- **expo-haptics** — Haptic feedback on native
- **expo-crypto** — UUID generation for device IDs
- **zod** + **drizzle-zod** — Schema validation

## Stability & Error Handling

- **Per-screen ErrorBoundary**: Each tab screen (Home, Following, Favorites, Downloads, Settings) is wrapped in its own ErrorBoundary, so a crash in one screen doesn't take down the entire app
- **Audio retry**: Web audio playback auto-retries up to 2 times on failure with exponential backoff; native resume is guarded against stale/unloaded sound refs
- **Download validation**: On app start (native only), downloads are verified to ensure local files still exist; stale entries are automatically cleaned up
- **Safe storage**: `lib/safe-storage.ts` provides `safeGetJSON`/`safeSetJSON` helpers with fallback values; all AsyncStorage JSON.parse calls are wrapped in try-catch throughout the codebase
- **Offline banner**: `components/OfflineBanner.tsx` displays a dismissible red banner when the device loses internet connectivity (uses browser events on web, expo-network polling on native)
- **Debug logs**: In-app debug log viewer accessible from Settings, captures errors, warnings, network failures, and unhandled promise rejections (filters out known dev warnings)
- **Error logger**: `lib/error-logger.ts` captures global errors and stores them in AsyncStorage for the debug log screen
- **Safe navigation**: `lib/safe-back.ts` provides `safeGoBack()` that checks `router.canGoBack()` and falls back to `router.replace("/(tabs)")` — prevents back button failures on Android
- **Remote error reports**: Errors and warnings are batched and sent to `/api/admin/error-reports` for remote diagnostics (flushes at 5 pending or every 30s)
- **Audio playback logging**: All play/resume/failure events are logged to the error logger with source "audio" for remote visibility