import React, { useRef, useState, useCallback } from "react";
import { View, TextInput, Platform, type TextInputProps, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import FocusableView from "@/components/FocusableView";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";

interface Props extends Omit<TextInputProps, "style"> {
  containerStyle?: ViewStyle;
  inputStyle?: ViewStyle;
  iconSize?: number;
}

/**
 * Search bar that works with D-pad navigation.
 * - D-pad focuses the outer container (shows focus ring)
 * - CENTER press opens the TextInput for typing
 * - BACK blurs the TextInput and returns focus to container
 * - On non-Android, behaves like a normal TextInput
 */
export default function DpadSearchBar({
  containerStyle,
  inputStyle,
  iconSize = 18,
  onFocus,
  onBlur,
  ...textInputProps
}: Props) {
  const inputRef = useRef<TextInput>(null);
  const [isEditing, setIsEditing] = useState(false);
  const colorScheme = useAppColorScheme();
  const colors = Colors[colorScheme];
  const isAndroid = Platform.OS === "android";

  const handleContainerPress = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleInputFocus = useCallback(
    (e: any) => {
      setIsEditing(true);
      onFocus?.(e);
    },
    [onFocus]
  );

  const handleInputBlur = useCallback(
    (e: any) => {
      setIsEditing(false);
      onBlur?.(e);
    },
    [onBlur]
  );

  return (
    <FocusableView
      onPress={handleContainerPress}
      focusRadius={12}
      style={[containerStyle]}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Ionicons
          name="search"
          size={iconSize}
          color={colors.textSecondary}
          style={{ marginLeft: 14 }}
        />
        <TextInput
          ref={inputRef}
          {...textInputProps}
          // On Android, make the TextInput non-focusable via D-pad
          // so focus stays on the FocusableView container
          focusable={isAndroid ? isEditing : undefined}
          style={[inputStyle, { color: colors.text }]}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
        />
      </View>
    </FocusableView>
  );
}
