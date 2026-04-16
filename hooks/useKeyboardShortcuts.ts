import { useEffect } from "react";
import { Platform } from "react-native";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";
import { usePathname } from "expo-router";
import { navigateToTab } from "@/hooks/useDpadTabNavigation";

const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function useKeyboardShortcuts() {
  const { playback, pause, resume, skip, setRate, currentEpisode } = useAudioPlayer();
  const pathname = usePathname();

  useEffect(() => {
    if (Platform.OS !== "web") return;

    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture when user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      switch (e.code) {
        case "Space":
          if (!currentEpisode) return;
          e.preventDefault();
          if (playback.isPlaying) {
            pause();
          } else {
            resume();
          }
          break;

        case "ArrowLeft":
          // On player page or when playing: seek audio; otherwise switch tabs
          if (pathname === "/player" && currentEpisode) {
            e.preventDefault();
            skip(-15);
          } else {
            e.preventDefault();
            navigateToTab("left", pathname);
          }
          break;

        case "ArrowRight":
          if (pathname === "/player" && currentEpisode) {
            e.preventDefault();
            skip(30);
          } else {
            e.preventDefault();
            navigateToTab("right", pathname);
          }
          break;

        case "Equal": // + key
        case "NumpadAdd":
          if (!currentEpisode) return;
          e.preventDefault();
          {
            const idx = RATE_STEPS.indexOf(playback.playbackRate);
            if (idx < RATE_STEPS.length - 1) {
              setRate(RATE_STEPS[idx + 1]);
            }
          }
          break;

        case "Minus":
        case "NumpadSubtract":
          if (!currentEpisode) return;
          e.preventDefault();
          {
            const idx = RATE_STEPS.indexOf(playback.playbackRate);
            if (idx > 0) {
              setRate(RATE_STEPS[idx - 1]);
            }
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [playback.isPlaying, playback.playbackRate, currentEpisode, pathname, pause, resume, skip, setRate]);
}
