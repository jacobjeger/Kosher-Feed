import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme, ScrollView, Platform, Switch, Alert, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl } from "@/lib/query-client";
import { useDownloads } from "@/contexts/DownloadsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { requestNotificationPermissions } from "@/lib/notifications";
import { lightHaptic } from "@/lib/haptics";

const EPISODE_LIMIT_OPTIONS = [3, 5, 10, 15, 25, 50];

interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
}

function SettingRow({ icon, label, value, onPress, rightElement }: SettingRowProps) {
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
      disabled={!onPress && !rightElement}
    >
      <View style={styles.settingLeft}>
        {icon}
        <Text style={[styles.settingLabel, { color: colors.text }]}>{label}</Text>
      </View>
      {rightElement ? rightElement : value ? (
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
  const { settings, updateSettings } = useSettings();
  const [deviceId, setDeviceId] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [connectionError, setConnectionError] = useState("");

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  const testConnection = async () => {
    setConnectionStatus("testing");
    setConnectionError("");
    try {
      const baseUrl = getApiUrl();
      const url = new URL("/api/feeds", baseUrl);
      const res = await fetch(url.toString(), { method: "GET" });
      if (res.ok) {
        const data = await res.json();
        setConnectionStatus("ok");
        setConnectionError(`${data.length} feeds loaded`);
      } else {
        setConnectionStatus("error");
        setConnectionError(`Server returned ${res.status}`);
      }
    } catch (e: any) {
      setConnectionStatus("error");
      setConnectionError(e.message || "Network request failed");
    }
  };

  const handleToggleNotifications = async (value: boolean) => {
    lightHaptic();
    if (value) {
      const granted = await requestNotificationPermissions();
      if (!granted && Platform.OS !== "web") {
        Alert.alert(
          "Notifications",
          "Please enable notifications in your device settings to receive alerts for new episodes."
        );
        return;
      }
    }
    updateSettings({ notificationsEnabled: value });
  };

  const handleToggleAutoDownload = (value: boolean) => {
    lightHaptic();
    updateSettings({ autoDownloadOnWifi: value });
  };

  const handleChangeEpisodeLimit = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = EPISODE_LIMIT_OPTIONS.indexOf(settings.maxEpisodesPerFeed);
      const nextIndex = (currentIndex + 1) % EPISODE_LIMIT_OPTIONS.length;
      updateSettings({ maxEpisodesPerFeed: EPISODE_LIMIT_OPTIONS[nextIndex] });
      return;
    }

    Alert.alert(
      "Episodes Per Shiur",
      "Choose how many episodes to keep downloaded per shiur.",
      EPISODE_LIMIT_OPTIONS.map(n => ({
        text: `${n} episodes`,
        onPress: () => updateSettings({ maxEpisodesPerFeed: n }),
      })),
    );
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 120 }}
    >
      <View style={{ paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>NOTIFICATIONS</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="notifications" size={20} color={colors.accent} />}
            label="New Episode Alerts"
            rightElement={
              <Switch
                value={settings.notificationsEnabled}
                onValueChange={handleToggleNotifications}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor="#fff"
              />
            }
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.settingDescription}>
            <Text style={[styles.descriptionText, { color: colors.textSecondary }]}>
              Get notified when new episodes are available from shiurim you follow.
            </Text>
          </View>
        </View>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>DOWNLOADS</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="wifi" size={20} color={colors.accent} />}
            label="Auto-Download on WiFi"
            rightElement={
              <Switch
                value={settings.autoDownloadOnWifi}
                onValueChange={handleToggleAutoDownload}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor="#fff"
              />
            }
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="layers" size={20} color={colors.accent} />}
            label="Episodes Per Shiur"
            value={`${settings.maxEpisodesPerFeed}`}
            onPress={handleChangeEpisodeLimit}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.settingDescription}>
            <Text style={[styles.descriptionText, { color: colors.textSecondary }]}>
              Automatically download new episodes from followed shiurim when connected to WiFi. Older episodes beyond the limit are removed automatically.
            </Text>
          </View>
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

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>CONNECTION</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="server" size={20} color={colors.accent} />}
            label="Server"
            value={getApiUrl().replace("https://", "")}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={
              connectionStatus === "testing" ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : connectionStatus === "ok" ? (
                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              ) : connectionStatus === "error" ? (
                <Ionicons name="alert-circle" size={20} color="#ef4444" />
              ) : (
                <Ionicons name="pulse" size={20} color={colors.accent} />
              )
            }
            label="Test Connection"
            value={connectionError || undefined}
            onPress={testConnection}
          />
        </View>
      </View>

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        ShiurPod{"\n"}A curated listening experience
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
  settingDescription: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  descriptionText: {
    fontSize: 12,
    lineHeight: 17,
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
