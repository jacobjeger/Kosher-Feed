// YTC: domain types for the YTC Alumni section. Verbatim port from
// /tmp/ytc-source/expo-app/types/index.ts; only the file path moved.
// Renamed `YTCEvent` → `YtcEvent` for naming consistency with the rest
// of this codebase (PascalCase camel, not all-caps). The original name
// is kept as a type alias so verbatim-ported screens compile unchanged.

export interface Shiur {
  id: string;
  title: string;
  rebbe: string;
  date: string; // "YYYY-MM-DD"
  tags: string[];
  audioUrl?: string;
  pdfUrl?: string;
  description?: string;
  playCount?: number;
  downloadCount?: number;
  series?: string;
}

export interface YtcEvent {
  id: string;
  eventName: string;
  personFamily: string;
  type: string;
  date: string; // "YYYY-MM-DD"
  location: string;
  time?: string;
  imageUrl?: string;
  description?: string;
}
export type YTCEvent = YtcEvent; // back-compat alias for verbatim ports

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: "mazel_tov" | "announcement";
  date: string;
  enabled: boolean;
}

export interface CarouselImage {
  id: string;
  url: string;
  caption?: string;
  order: number;
}

export interface AlumniContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  location: string;
  submittedAt?: string;
}

export interface Rebbe {
  id: string;
  name: string;
  title: string;
  email?: string;
  phone?: string;
  photoUrl?: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  isApproved: boolean;
  isAdmin: boolean;
}
