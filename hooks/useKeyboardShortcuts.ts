import { useEffect } from "react";
import { Platform } from "react-native";
import { useAudioPlayer } from "@/contexts/AudioPlayerContext";

const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function useKeyboardShortcuts() {
  const { playback, pause, resume, skip, setRate, currentEpisode } = useAudioPlayer();

  useEffect(() => {
    if (Platform.OS !== "web") return;

    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture when user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // No episode loaded — nothing to control
      if (!currentEpisode) return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          if (playback.isPlaying) {
            pause();
          } else {
            resume();
          }
          break;

        case "ArrowLeft":
          e.preventDefault();
          skip(-15);
          break;

        case "ArrowRight":
          e.preventDefault();
          skip(30);
          break;

        case "Equal": // + key
        case "NumpadAdd":
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
  }, [playback.isPlaying, playback.playbackRate, currentEpisode, pause, resume, skip, setRate]);
}
