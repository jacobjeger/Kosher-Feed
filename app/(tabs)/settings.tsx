import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme, ScrollView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { useDownloads } from "@/contexts/DownloadsContext";

interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onPress?: () => void;
}

function SettingRow({ icon, label, value, onPress }: SettingRowProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.settingRow,
        { backgroundColor: pressed && onPress ? colors.surfaceAlt : colors.surface },
      ]}
      onPress={onPress}
      disabled={!onPress}
    >
      <View style={styles.settingLeft}>
        {icon}
        <Text style={[styles.settingLabel, { color: colors.text }]}>{label}</Text>
      </View>
      {value ? (
        <Text style={[styles.settingValue, { color: colors.textSecondary }]}>{value}</Text>
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
      ) : null}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { downloads } = useDownloads();
  const [deviceId, setDeviceId] = useState("");

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 120 }}
    >
      <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>ABOUT</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="headset" size={20} color={colors.accent} />}
            label="App Version"
            value="1.0.0"
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Feather name="smartphone" size={20} color={colors.accent} />}
            label="Device ID"
            value={deviceId.slice(0, 8) + "..."}
          />
        </View>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>STORAGE</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="cloud-download" size={20} color={colors.accent} />}
            label="Downloaded Episodes"
            value={`${downloads.length}`}
          />
        </View>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>INFO</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="shield-checkmark" size={20} color={colors.success} />}
            label="Content Policy"
            value="Curated Only"
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="information-circle" size={20} color={colors.accent} />}
            label="All content is reviewed and approved"
          />
        </View>
      </View>

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        Kosher Shiurim{"\n"}A curated listening experience
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    paddingHorizontal: 4,
    marginBottom: 24,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.8,
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  sectionContent: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  settingLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: "500",
  },
  settingValue: {
    fontSize: 14,
  },
  divider: {
    height: 1,
    marginLeft: 48,
  },
  footer: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 24,
    marginBottom: 20,
  },
});
