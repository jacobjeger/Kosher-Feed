// The downloaded-file lookup decides, for every play, whether audio comes off
// the disk or the network.
//
//   npx tsx --test scripts/test-local-audio.ts
//
// The dangerous case is not "fails to find the file" — that just streams, which
// is what the app did before. It is returning something that is NOT a local
// file and having the player treat it as one. A download record's localUri is
// seeded with the REMOTE audioUrl as a placeholder, so a naive lookup hands
// back the very URL the download was meant to avoid, and offline playback
// silently becomes a network request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setLocalAudioLookup, getLocalAudioUri } from "../lib/local-audio";

test("returns a real on-device file", () => {
  setLocalAudioLookup(() => "file:///data/user/0/com.shiurpod.app/Podcasts/abc.mp3");
  assert.equal(getLocalAudioUri("ep1"), "file:///data/user/0/com.shiurpod.app/Podcasts/abc.mp3");
  setLocalAudioLookup(() => "/var/mobile/Containers/Data/Application/x/Podcasts/abc.mp3");
  assert.equal(getLocalAudioUri("ep1"), "/var/mobile/Containers/Data/Application/x/Podcasts/abc.mp3");
});

test("refuses a remote URL masquerading as a download", () => {
  // The placeholder case: localUri === audioUrl. Returning this would make the
  // player think it had a local file and quietly stream instead.
  for (const remote of [
    "https://media.blubrry.com/x/y.mp3",
    "http://download.yutorah.org/a/b.mp3",
    "https://shiurpod.com/api/audio/kh/42814637",
  ]) {
    setLocalAudioLookup(() => remote);
    assert.equal(getLocalAudioUri("ep1"), null, remote);
  }
});

test("streams when there is no download, no lookup, or no id", () => {
  setLocalAudioLookup(() => null);
  assert.equal(getLocalAudioUri("ep1"), null);
  setLocalAudioLookup(() => "");
  assert.equal(getLocalAudioUri("ep1"), null);
  setLocalAudioLookup(null);
  assert.equal(getLocalAudioUri("ep1"), null);
  setLocalAudioLookup(() => "file:///x.mp3");
  assert.equal(getLocalAudioUri(""), null);
});

test("a broken downloads layer degrades to streaming, never throws", () => {
  // If this threw, it would take playback down from every entry point at once
  // — strictly worse than the bug it fixes.
  setLocalAudioLookup(() => {
    throw new Error("AsyncStorage exploded");
  });
  assert.doesNotThrow(() => getLocalAudioUri("ep1"));
  assert.equal(getLocalAudioUri("ep1"), null);
});

test("the lookup receives the episode id it was asked about", () => {
  const seen: string[] = [];
  setLocalAudioLookup((id) => {
    seen.push(id);
    return null;
  });
  getLocalAudioUri("episode-42");
  assert.deepEqual(seen, ["episode-42"]);
  setLocalAudioLookup(null);
});
