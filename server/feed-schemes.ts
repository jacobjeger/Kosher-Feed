// Custom feed URL schemes.
//
// feeds.rssUrl does not always hold an HTTP URL. Platform-backed feeds store a
// scheme that names the adapter that owns them, and contributor shows store
// cp://show/{id}. Anything in this list must never be handed to axios or to
// parseFeed — that is the failure mode this file exists to prevent, and it is
// silent: the refresh loop throws per-feed, logs one line, and the feed simply
// stops updating.
//
// These checks were previously inlined as ad-hoc string lists in a dozen
// places, so adding a scheme meant finding every one of them. Adding cp://
// required touching six. New code should call isCustomSchemeUrl() instead of
// writing another list.

export const TAT_SCHEME = "tat://";
export const KH_SCHEME = "kh://";
export const TD_SCHEME = "td://";
export const YT_SCHEME = "yt://";
export const CONTRIBUTOR_SCHEME = "cp://";

/** OU-family schemes, which are also enumerated in OU_PLATFORMS. */
export const OU_SCHEMES = ["alldaf://", "allmishnah://", "allparsha://", "allhalacha://"] as const;

/** Every non-HTTP scheme that can appear in feeds.rssUrl. */
export const CUSTOM_FEED_SCHEMES: readonly string[] = [
  TAT_SCHEME,
  KH_SCHEME,
  TD_SCHEME,
  YT_SCHEME,
  CONTRIBUTOR_SCHEME,
  ...OU_SCHEMES,
];

/** True when this URL is adapter-owned and must not be fetched over HTTP. */
export function isCustomSchemeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return CUSTOM_FEED_SCHEMES.some((s) => url.startsWith(s));
}

/** True for a feed whose episodes are written directly rather than parsed. */
export function isContributorFeedUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith(CONTRIBUTOR_SCHEME);
}

export function contributorFeedUrl(showId: string): string {
  return `${CONTRIBUTOR_SCHEME}show/${showId}`;
}

export function extractContributorShowId(url: string | null | undefined): string | null {
  if (!isContributorFeedUrl(url)) return null;
  const id = url!.slice(`${CONTRIBUTOR_SCHEME}show/`.length);
  return id || null;
}
