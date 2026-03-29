import React, { useCallback, useRef, useState } from "react";
import { Pressable, Platform, type ViewStyle, type PressableProps } from "react-native";
import { lightHaptic } from "@/lib/haptics";
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
 * - Renders a visible focus ring (2px accent border) when focused via D-pad
 * - Fires haptic feedback on focus gain
 * - Supports autoFocus for initial focus placement
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
  const ref = useRef<any>(null);

  const handleFocus = useCallback(
    (e: any) => {
      setIsFocused(true);
      lightHaptic();
      onFocus?.(e);
    },
    [onFocus]
  );

  const handleBlur = useCallback(
    (e: any) => {
      setIsFocused(false);
      onBlur?.(e);
    },
    [onBlur]
  );

  const isAndroid = Platform.OS === "android";

  const focusRingStyle: ViewStyle | undefined =
    isAndroid && isFocused
      ? focusStyle ?? {
          borderWidth: 2,
          borderColor: colors.accent,
          borderRadius: focusRadius,
        }
      : undefined;

  return (
    <Pressable
      ref={ref}
      {...rest}
      focusable={isAndroid ? true : undefined}
      hasTVPreferredFocus={isAndroid && autoFocus ? true : undefined}
      onFocus={isAndroid ? handleFocus : onFocus}
      onBlur={isAndroid ? handleBlur : onBlur}
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
