# ShiurPod

## Overview

ShiurPod is a mobile-first application for listening to curated Torah lectures ("shiurim"). Built with Expo (React Native) for the frontend and Express.js for the backend, it enables users to browse, follow, and listen to shiur feeds. Key features include audio playback with position saving, offline listening via episode downloads, automatic downloads on WiFi, new episode notifications, and device-based subscriptions without user accounts. An admin panel facilitates feed and category management. The backend functions as both an API and a static file server.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend (Expo / React Native)
- **Framework**: Expo SDK 54 with React Native 0.81, utilizing `expo-router` for file-based routing.
- **Navigation**: Tab-based navigation (Home, Following, Downloads, Settings) with dedicated screens for audio player, queue, podcast details, and speaker details.
- **State Management**: React Context manages audio playback, downloads, user settings, favorites, and played episodes. TanStack React Query handles server state.
- **Audio Playback**: Uses `expo-audio` for native platforms (background playback, lock-screen controls) and HTML5 Audio for web, unified via `AudioPlayerContext`. Playback position is saved locally and synced server-side.
- **Offline Support**: `expo-file-system` handles episode downloads, including auto-download on WiFi for followed shiurim and batch downloads.
- **Notifications**: Expo push notifications for new episodes on native, and local browser notifications for web. Background tasks (`expo-background-task`) check for new episodes.
- **Device Identification**: Anonymous device IDs are generated and stored locally, eliminating the need for user accounts.
- **Styling**: React Native StyleSheet with a custom color system supporting light/dark themes.
- **Error Handling**: Per-screen ErrorBoundaries, audio retry mechanisms, download validation, safe storage utilities, offline banners, and an in-app debug log viewer with remote error reporting.
- **UX Enhancements (Feb 2026)**: Recently Added section on home screen, What's New badge on PodcastCards with unplayed episodes, swipe-to-queue/download gestures on episode cards (native only), loading skeletons replacing spinners, buffering indicators on player and mini-player, pre-buffering next queue episode, auto-retry failed downloads with exponential backoff, improved offline indicators (greyed-out play buttons, green available-offline badges, OfflineBanner with "Go to Downloads" link), skip silence setting, press-scale animations on cards, fade tab transitions, springify mini-player animation.

### Backend (Express.js)
- **Server**: Express 5 serving a RESTful JSON API under `/api/` and static web content.
- **Key Functionality**: Provides endpoints for managing feeds, categories, subscriptions, favorites, playback positions, push tokens, and listening statistics. Includes specific endpoints for search, trending episodes, and sharing.
- **RSS Parsing**: Employs a SAX streaming parser for efficient RSS feed fetching, with fallback to `rss-parser`. Uses conditional GET requests (ETag/Last-Modified) and bounded concurrency for feed refreshing.
- **Admin Panel**: Server-rendered HTML interface for managing content, protected by basic authentication.
- **Performance**: Utilizes gzip compression and `Cache-Control` headers.

### Database (PostgreSQL + Drizzle ORM)
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**:
    - `categories`: Podcast categories.
    - `feeds`: Podcast feeds with metadata.
    - `feedCategories`: Many-to-many link between feeds and categories.
    - `episodes`: Individual lecture episodes.
    - `subscriptions`: Device-feed subscriptions.
    - `admin_users`: Admin credentials.
    - `favorites`: Favorite episodes per device.
    - `playbackPositions`: Server-synced playback positions.
    - `push_tokens`: Expo push notification tokens.
    - `episodeListens`: Tracking for trending analytics.
    - `maggid_shiurim`: Customizable speaker profiles.
    - `sponsors`: Loading screen sponsors.
- **Migrations**: Managed via `drizzle-kit push`.

### Build & Deployment
- **Development**: Separate processes for Expo dev server and Express API.
- **Production**: Custom build script creates a static web export, served by Express alongside the API.
- **Shared Code**: `shared/` directory contains common schema and types for frontend and backend.

## External Dependencies

### Required Services
- **PostgreSQL**: Primary database.

### Key NPM Packages
- **expo**: React Native framework.
- **expo-router**: File-based routing.
- **expo-audio**: Native audio playback.
- **expo-file-system**: Local file operations.
- **@tanstack/react-query**: Server state management.
- **drizzle-orm**, **drizzle-kit**, **pg**: Database ORM and client.
- **express**: HTTP server.
- **rss-parser**: RSS feed parsing.
- **react-native-reanimated**: Animations.
- **@react-native-async-storage/async-storage**: Persistent storage.
- **zod**, **drizzle-zod**: Schema validation.