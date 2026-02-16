import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Platform, Switch, Alert, ActivityIndicator } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl } from "@/lib/query-client";
import { useDownloads } from "@/contexts/DownloadsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { requestNotificationPermissions } from "@/lib/notifications";
import { lightHaptic } from "@/lib/haptics";

const EPISODE_LIMIT_OPTIONS = [3, 5, 10, 15, 25, 50];
const SKIP_OPTIONS = [10, 15, 30, 45, 60];
const THEME_OPTIONS: Array<'system' | 'light' | 'dark'> = ['system', 'light', 'dark'];
const THEME_LABELS: Record<string, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const REMINDER_HOUR_OPTIONS = [6, 7, 8, 9, 10, 12, 18, 20];

interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
}

function SettingRow({ icon, label, value, onPress, rightElement }: SettingRowProps) {
  const colorScheme = useAppColorScheme();
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
  const colorScheme = useAppColorScheme();
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
    const startTime = Date.now();
    try {
      const baseUrl = getApiUrl();
      const url = new URL("/api/ping", baseUrl);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url.toString(), { method: "GET", signal: controller.signal });
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      if (res.ok) {
        setConnectionStatus("ok");
        setConnectionError(`Connected (${elapsed}ms)`);
      } else {
        setConnectionStatus("error");
        setConnectionError(`Server returned ${res.status}`);
      }
    } catch (e: any) {
      const elapsed = Date.now() - startTime;
      setConnectionStatus("error");
      if (e.name === "AbortError") {
        setConnectionError(`Timed out after ${elapsed}ms`);
      } else {
        setConnectionError(e.message || "Network request failed");
      }
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

  const handleChangeSkipForward = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = SKIP_OPTIONS.indexOf(settings.skipForwardSeconds);
      const nextIndex = (currentIndex + 1) % SKIP_OPTIONS.length;
      updateSettings({ skipForwardSeconds: SKIP_OPTIONS[nextIndex] });
      return;
    }
    Alert.alert(
      "Skip Forward",
      "Choose skip forward duration.",
      SKIP_OPTIONS.map(n => ({
        text: `${n}s`,
        onPress: () => updateSettings({ skipForwardSeconds: n }),
      })),
    );
  };

  const handleChangeSkipBackward = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = SKIP_OPTIONS.indexOf(settings.skipBackwardSeconds);
      const nextIndex = (currentIndex + 1) % SKIP_OPTIONS.length;
      updateSettings({ skipBackwardSeconds: SKIP_OPTIONS[nextIndex] });
      return;
    }
    Alert.alert(
      "Skip Backward",
      "Choose skip backward duration.",
      SKIP_OPTIONS.map(n => ({
        text: `${n}s`,
        onPress: () => updateSettings({ skipBackwardSeconds: n }),
      })),
    );
  };

  const handleToggleAudioBoost = (value: boolean) => {
    lightHaptic();
    updateSettings({ audioBoostEnabled: value });
  };

  const handleChangeTheme = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = THEME_OPTIONS.indexOf(settings.darkModeOverride);
      const nextIndex = (currentIndex + 1) % THEME_OPTIONS.length;
      updateSettings({ darkModeOverride: THEME_OPTIONS[nextIndex] });
      return;
    }
    Alert.alert(
      "Theme",
      "Choose app theme.",
      THEME_OPTIONS.map(t => ({
        text: THEME_LABELS[t],
        onPress: () => updateSettings({ darkModeOverride: t }),
      })),
    );
  };

  const handleToggleDailyReminder = (value: boolean) => {
    lightHaptic();
    updateSettings({ dailyReminderEnabled: value });
  };

  const handleChangeReminderHour = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = REMINDER_HOUR_OPTIONS.indexOf(settings.dailyReminderHour);
      const nextIndex = (currentIndex + 1) % REMINDER_HOUR_OPTIONS.length;
      updateSettings({ dailyReminderHour: REMINDER_HOUR_OPTIONS[nextIndex] });
      return;
    }
    Alert.alert(
      "Reminder Time",
      "Choose reminder time.",
      REMINDER_HOUR_OPTIONS.map(h => ({
        text: formatHour(h),
        onPress: () => updateSettings({ dailyReminderHour: h }),
      })),
    );
  };

  const formatHour = (hour: number): string => {
    const period = hour >= 12 ? "PM" : "AM";
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h}:00 ${period}`;
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
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>PLAYBACK</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="play-forward" size={20} color={colors.accent} />}
            label="Skip Forward"
            value={`${settings.skipForwardSeconds}s`}
            onPress={handleChangeSkipForward}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="play-back" size={20} color={colors.accent} />}
            label="Skip Backward"
            value={`${settings.skipBackwardSeconds}s`}
            onPress={handleChangeSkipBackward}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="volume-high" size={20} color={colors.accent} />}
            label="Audio Boost"
            rightElement={
              <Switch
                value={settings.audioBoostEnabled}
                onValueChange={handleToggleAudioBoost}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor="#fff"
              />
            }
          />
        </View>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>APPEARANCE</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="color-palette" size={20} color={colors.accent} />}
            label="Theme"
            value={THEME_LABELS[settings.darkModeOverride]}
            onPress={handleChangeTheme}
          />
        </View>
      </View>

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>REMINDERS</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="alarm" size={20} color={colors.accent} />}
            label="Daily Reminder"
            rightElement={
              <Switch
                value={settings.dailyReminderEnabled}
                onValueChange={handleToggleDailyReminder}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor="#fff"
              />
            }
          />
          {settings.dailyReminderEnabled && (
            <>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <SettingRow
                icon={<Ionicons name="time" size={20} color={colors.accent} />}
                label="Reminder Time"
                value={formatHour(settings.dailyReminderHour)}
                onPress={handleChangeReminderHour}
              />
            </>
          )}
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
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="stats-chart" size={20} color={colors.accent} />}
            label="Listening History"
            value="View"
            onPress={() => router.push('/stats')}
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
