# Kosher Podcasts

## Overview

Kosher Podcasts is a mobile-first podcast listening application built with Expo (React Native) on the frontend and Express.js on the backend. It allows users to browse, follow, and listen to curated podcast feeds. The app includes features like audio playback, episode downloads for offline listening, device-based subscriptions (no user accounts), and an admin panel for managing podcast feeds and categories. The backend serves as both an API server and a static file server for the web build.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend (Expo / React Native)
- **Framework**: Expo SDK 54 with React Native 0.81, using expo-router for file-based routing
- **Routing structure**: Tab-based navigation with 4 tabs (Home, Following, Downloads, Settings), a modal player screen, and a podcast detail screen at `podcast/[id]`
- **State management**: React Context for audio playback (`AudioPlayerContext`) and downloads (`DownloadsContext`); TanStack React Query for server state
- **Audio playback**: Uses `expo-av` for native and HTML5 Audio for web, with a unified context API providing play/pause/seek/skip/rate controls
- **Offline support**: Episode downloads managed via `expo-file-system` with progress tracking, persisted to AsyncStorage
- **Device identification**: Anonymous device IDs generated with `expo-crypto` and stored in AsyncStorage — no user accounts required for subscriptions
- **Styling**: Plain React Native StyleSheet with a custom color system supporting light/dark themes (defined in `constants/colors.ts`)
- **Haptics**: Optional haptic feedback on iOS/Android via `expo-haptics`, gracefully skipped on web

### Backend (Express.js)
- **Server**: Express 5 running on port 5000 (configured in `server/index.ts`)
- **API pattern**: RESTful JSON API under `/api/` prefix
- **Key endpoints**:
  - `GET /api/feeds` — list all feeds
  - `GET /api/feeds/:id/episodes` — episodes for a feed
  - `GET /api/categories` — list categories
  - `POST/DELETE /api/subscriptions` — manage device subscriptions
  - `GET /api/subscriptions/:deviceId/feeds` — get subscribed feeds
  - Admin CRUD endpoints for feeds/categories (Basic auth protected)
- **RSS parsing**: `rss-parser` library fetches and parses podcast RSS feeds, extracting episode metadata
- **Admin panel**: Server-rendered HTML admin interface at `/admin` for managing feeds and categories
- **Admin auth**: Simple Basic auth with bcrypt-hashed passwords, default credentials `admin/admin123`
- **CORS**: Dynamic origin allowlist based on Replit environment variables, plus localhost support for dev

### Database (PostgreSQL + Drizzle ORM)
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema** (defined in `shared/schema.ts`):
  - `categories` — podcast categories (id, name, slug)
  - `feeds` — podcast feeds (id, title, rssUrl, imageUrl, description, author, categoryId, isActive, lastFetchedAt)
  - `episodes` — individual episodes (id, feedId, title, description, audioUrl, duration, publishedAt, guid, imageUrl) with unique index on (guid, feedId)
  - `subscriptions` — device-feed subscriptions with unique index on (deviceId, feedId)
  - `admin_users` — admin credentials for the management panel
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
- **expo-av** / **expo-audio** — Audio playback on native platforms
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