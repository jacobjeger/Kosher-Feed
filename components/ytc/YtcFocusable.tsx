// YTC: drop-in focusable Pressable with a gold ring when D-pad-focused.
//
// TouchableOpacity already accepts D-pad focus on Android, but its only
// visual indicator is a slight opacity change — invisible on most YTC
// surfaces because the cards are already light. This component uses
// Pressable's `focused` state to draw a 2px gold ring.
//
// Layout-stable: the ring uses an always-rendered border with
// transparent baseline color, so width doesn't change when focus
// transitions in/out. Avoids the visual jump that would happen with
// `borderWidth: focused ? 2 : 0`.
//
// Usage: drop-in for TouchableOpacity. Same props (onPress, hitSlop,
// disabled, accessibility*). The `style` prop accepts a ViewStyle, an
// array of ViewStyles, or a function — same as Pressable.

import React from "react";
import { Pressable, type PressableProps, type ViewStyle, type StyleProp } from "react-native";
import { ytcColors } from "@/constants/ytcColors";

// RN's public PressableStateCallbackType doesn't yet expose `focused`,
// but the prop IS passed at runtime on Android (Pressable supports
// D-pad focus). Cast to a wider state type so we can read it without
// a TS error.
type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

interface Props extends Omit<PressableProps, "style"> {
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressState) => StyleProp<ViewStyle>);
  /** Override the focus ring (default: 2px gold border). Pass `null` to disable. */
  focusStyle?: ViewStyle | null;
  /** Border radius matched on the focus ring (purely cosmetic — doesn't change clipping). */
  focusRadius?: number;
}

const TRANSPARENT_BORDER: ViewStyle = { borderWidth: 2, borderColor: "transparent" };
const GOLD_RING: ViewStyle = { borderColor: ytcColors.gold };

export function YtcFocusable({
  style,
  focusStyle,
  focusRadius,
  children,
  ...rest
}: Props) {
  return (
    <Pressable
      {...rest}
      style={(rawState) => {
        const state = rawState as PressState;
        const userStyle = typeof style === "function" ? style(state) : style;
        const ring = focusStyle === null
          ? null
          : state.focused
            ? (focusStyle ?? GOLD_RING)
            : null;
        const radius = focusRadius != null ? { borderRadius: focusRadius } : null;
        return [TRANSPARENT_BORDER, userStyle, radius, ring];
      }}
    >
      {children as any}
    </Pressable>
  );
}
