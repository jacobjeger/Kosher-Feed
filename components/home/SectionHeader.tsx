import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Typography from "@/constants/typography";
import { lightHaptic } from "@/lib/haptics";

interface Props {
  title: string;
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  colors: any;
  seeAllLabel?: string;
  onSeeAll?: () => void;
}

export default React.memo(function SectionHeader({ title, icon, iconColor, colors, seeAllLabel = "See All", onSeeAll }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.left}>
        {icon && <Ionicons name={icon} size={18} color={iconColor || colors.accent} />}
        <Text style={[Typography.sectionTitle, { color: colors.text }]}>{title}</Text>
      </View>
      {onSeeAll && (
        <Pressable
          onPress={() => { lightHaptic(); onSeeAll(); }}
          style={({ pressed }) => [styles.seeAllBtn, { backgroundColor: colors.accentLight, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.seeAllText, { color: colors.accent }]}>{seeAllLabel}</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.accent} />
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  seeAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  seeAllText: {
    fontSize: 13,
    fontWeight: "600",
  },
});
