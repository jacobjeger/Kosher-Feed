// Letting the player find a downloaded file.
//
// Downloading an episode only helped if you started it from the Downloads tab.
// That screen swapped in the local file by hand; nothing else did, so the same
// downloaded shiur played from a podcast page, search, the home screen, the
// queue or a deep link streamed from the network instead. EpisodeItem even
// called isDownloaded() to draw the "downloaded" badge and then handed
// playEpisode() the remote URL anyway — the app knew it had the file on disk
// and went to the network regardless. Offline playback and poor reception were
// both broken by it, and it turned Kol Halashon's block on 2026-09-05 into
// "nothing plays, even downloads".
//
// The fix belongs in the player, so every entry point gets it. AudioPlayerProvider
// WRAPS DownloadsProvider (app/_layout.tsx), so the player cannot useDownloads()
// — the downloads context is its descendant. Hence this registry: the same
// module-level indirection the codebase already uses for setAudioProxyRules and
// applyDownloadConfig. DownloadsProvider registers a lookup once it is mounted;
// until then, and on web, the player just streams as before.

let lookup: ((episodeId: string) => string | null) | null = null;

/** Called by DownloadsProvider. Passing null unregisters. */
export function setLocalAudioLookup(fn: ((episodeId: string) => string | null) | null) {
  lookup = fn;
}

/**
 * True for a URI that actually points at a file on this device.
 *
 * A download record's localUri is NOT always a local path. It is seeded with
 * the remote audioUrl as a placeholder (DownloadsContext seeds it that way on
 * web, and the record survives validation while it still matches), so handing
 * that back would "resolve" a download to the very URL we were trying to avoid.
 */
function isLocalUri(uri: string): boolean {
  if (!uri) return false;
  if (/^https?:\/\//i.test(uri)) return false;
  return uri.startsWith("file://") || uri.startsWith("/");
}

/**
 * The on-device file for this episode, or null to stream.
 *
 * Never throws: a download layer that is missing, still loading or broken must
 * degrade to streaming rather than take playback down with it.
 */
export function getLocalAudioUri(episodeId: string): string | null {
  if (!lookup || !episodeId) return null;
  try {
    const uri = lookup(episodeId);
    return uri && isLocalUri(uri) ? uri : null;
  } catch {
    return null;
  }
}
