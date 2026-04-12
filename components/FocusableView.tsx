import React, { useCallback, useState } from "react";
import { Pressable, Platform, type ViewStyle, type PressableProps } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";

interface FocusableViewProps extends PressableProps {
  /** Custom style applied when the view has D-pad focus */
  focusStyle?: ViewStyle;
  /** If true, this view receives focus when the screen opens */
  autoFocus?: boolean;
  /** Border radius to match on the focus ring (default: 8) */
  focusRadius?: number;
}

/**
 * Drop-in replacement for Pressable that adds D-pad focus support on Android.
 * On iOS/web, behaves identically to Pressable.
 *
 * Focus indicator: 2px accent border + subtle background tint for visibility.
 */
export default function FocusableView({
  focusStyle,
  autoFocus,
  focusRadius = 8,
  style,
  onFocus,
  onBlur,
  children,
  ...rest
}: FocusableViewProps) {
  const [isFocused, setIsFocused] = useState(false);
  const colorScheme = useAppColorScheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === "dark";

  const handleFocus = useCallback(
    (e: any) => {
      try {
        setIsFocused(true);
        onFocus?.(e);
      } catch {}
    },
    [onFocus]
  );

  const handleBlur = useCallback(
    (e: any) => {
      try {
        setIsFocused(false);
        onBlur?.(e);
      } catch {}
    },
    [onBlur]
  );

  const isAndroid = Platform.OS === "android";

  // Visible focus: thick border + background tint + subtle scale for d-pad visibility
  const focusRingStyle: ViewStyle | undefined =
    isAndroid && isFocused
      ? focusStyle ?? {
          borderWidth: 3,
          borderColor: "#60a5fa",
          borderRadius: focusRadius,
          backgroundColor: isDark ? "rgba(96,165,250,0.15)" : "rgba(37,99,235,0.10)",
          transform: [{ scale: 1.02 }],
        }
      : undefined;

  const focusProps: any = {};
  if (isAndroid) {
    focusProps.focusable = true;
    focusProps.onFocus = handleFocus;
    focusProps.onBlur = handleBlur;
  }

  return (
    <Pressable
      {...rest}
      {...focusProps}
      style={(pressState) => {
        const baseStyle =
          typeof style === "function" ? style(pressState) : style;
        return [baseStyle, focusRingStyle];
      }}
    >
      {children}
    </Pressable>
  );
}
