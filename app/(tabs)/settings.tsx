import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Platform, Switch, Alert, ActivityIndicator, TextInput, Modal, KeyboardAvoidingView } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl, apiRequest } from "@/lib/query-client";
import { useDownloads } from "@/contexts/DownloadsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { requestNotificationPermissions, sendLocalNotification, checkNotificationPermission, setupNotificationChannel } from "@/lib/notifications";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getLogsSnapshot } from "@/lib/error-logger";
import OptionPickerModal, { type PickerOption } from "@/components/OptionPickerModal";

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

function SettingsScreenInner() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { downloads } = useDownloads();
  const { settings, updateSettings } = useSettings();
  const [deviceId, setDeviceId] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [connectionError, setConnectionError] = useState("");
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackType, setFeedbackType] = useState<"shiur_request" | "technical_issue">("shiur_request");
  const [feedbackSubject, setFeedbackSubject] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackContact, setFeedbackContact] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [activePicker, setActivePicker] = useState<string | null>(null);

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
      await setupNotificationChannel();
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

  const handleSubmitFeedback = async () => {
    if (!feedbackSubject.trim() || !feedbackMessage.trim()) {
      Alert.alert("Missing Info", "Please fill in both the subject and details.");
      return;
    }
    setFeedbackSending(true);
    try {
      let deviceLogs: string | null = null;
      if (feedbackType === "technical_issue") {
        try {
          const logs = getLogsSnapshot();
          if (logs.length > 0) {
            deviceLogs = JSON.stringify(logs.slice(0, 100));
          }
        } catch {}
      }
      await apiRequest("POST", "/api/feedback", {
        deviceId,
        type: feedbackType,
        subject: feedbackSubject.trim(),
        message: feedbackMessage.trim(),
        contactInfo: feedbackContact.trim() || null,
        deviceLogs,
      });
      mediumHaptic();
      setShowFeedbackModal(false);
      setFeedbackSubject("");
      setFeedbackMessage("");
      setFeedbackContact("");
      Alert.alert("Thank You", feedbackType === "shiur_request"
        ? "Your shiur request has been submitted. We'll review it soon!"
        : "Your report has been submitted. We'll look into it!");
    } catch (e: any) {
      Alert.alert("Error", "Failed to send feedback. Please try again.");
    } finally {
      setFeedbackSending(false);
    }
  };

  const handleChangeEpisodeLimit = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = EPISODE_LIMIT_OPTIONS.indexOf(settings.maxEpisodesPerFeed);
      const nextIndex = (currentIndex + 1) % EPISODE_LIMIT_OPTIONS.length;
      updateSettings({ maxEpisodesPerFeed: EPISODE_LIMIT_OPTIONS[nextIndex] });
      return;
    }
    setActivePicker("episodeLimit");
  };

  const handleChangeSkipForward = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = SKIP_OPTIONS.indexOf(settings.skipForwardSeconds);
      const nextIndex = (currentIndex + 1) % SKIP_OPTIONS.length;
      updateSettings({ skipForwardSeconds: SKIP_OPTIONS[nextIndex] });
      return;
    }
    setActivePicker("skipForward");
  };

  const handleChangeSkipBackward = () => {
    lightHaptic();
    if (Platform.OS === "web") {
      const currentIndex = SKIP_OPTIONS.indexOf(settings.skipBackwardSeconds);
      const nextIndex = (currentIndex + 1) % SKIP_OPTIONS.length;
      updateSettings({ skipBackwardSeconds: SKIP_OPTIONS[nextIndex] });
      return;
    }
    setActivePicker("skipBackward");
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
    setActivePicker("theme");
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
    setActivePicker("reminderHour");
  };

  const handleTestNotification = async () => {
    lightHaptic();
    const hasPermission = await checkNotificationPermission();
    if (!hasPermission) {
      const granted = await requestNotificationPermissions();
      if (!granted) {
        Alert.alert("Notifications", "Please enable notifications in your device settings first.");
        return;
      }
    }
    const testEpisode = {
      id: "test-" + Date.now(),
      feedId: "test",
      title: "This is a test notification from ShiurPod",
      audioUrl: "",
      description: "",
      publishedAt: new Date().toISOString(),
      guid: "test",
    };
    const testFeed = {
      id: "test",
      title: "ShiurPod",
      rssUrl: "",
      imageUrl: null,
      description: "",
      author: "",
      categoryId: null,
      isActive: true,
      isFeatured: false,
      lastFetchedAt: null,
    };
    await sendLocalNotification(testEpisode as any, testFeed as any);
    Alert.alert("Sent", "A test notification was sent. Check your notification shade.");
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
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="play-skip-forward" size={20} color={colors.accent} />}
            label="Continuous Playback"
            rightElement={
              <Switch
                value={settings.continuousPlayback}
                onValueChange={(value: boolean) => { lightHaptic(); updateSettings({ continuousPlayback: value }); }}
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
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>FEEDBACK</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="musical-notes" size={20} color={colors.accent} />}
            label="Request a Shiur"
            onPress={() => { lightHaptic(); setFeedbackType("shiur_request"); setShowFeedbackModal(true); }}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="construct" size={20} color="#f59e0b" />}
            label="Report a Problem"
            onPress={() => { lightHaptic(); setFeedbackType("technical_issue"); setShowFeedbackModal(true); }}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.settingDescription}>
            <Text style={[styles.descriptionText, { color: colors.textSecondary }]}>
              Request new shiurim to be added or report any issues you're experiencing.
            </Text>
          </View>
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

      <View style={[styles.section, { borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>DEVELOPER</Text>
        <View style={[styles.sectionContent, { backgroundColor: colors.surface, borderColor: colors.cardBorder }]}>
          <SettingRow
            icon={<Ionicons name="notifications-outline" size={20} color={colors.accent} />}
            label="Test Notification"
            onPress={handleTestNotification}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <SettingRow
            icon={<Ionicons name="bug" size={20} color="#ef4444" />}
            label="Debug Logs"
            onPress={() => router.push("/debug-logs")}
          />
        </View>
      </View>

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        ShiurPod{"\n"}A curated listening experience
      </Text>

      <Modal
        visible={showFeedbackModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFeedbackModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1 }}
        >
          <Pressable
            style={feedbackStyles.overlay}
            onPress={() => setShowFeedbackModal(false)}
          >
            <Pressable
              style={[feedbackStyles.modal, { backgroundColor: colors.surface }]}
              onPress={() => {}}
            >
              <View style={feedbackStyles.modalHeader}>
                <Text style={[feedbackStyles.modalTitle, { color: colors.text }]}>
                  {feedbackType === "shiur_request" ? "Request a Shiur" : "Report a Problem"}
                </Text>
                <Pressable onPress={() => setShowFeedbackModal(false)}>
                  <Ionicons name="close" size={24} color={colors.textSecondary} />
                </Pressable>
              </View>

              <Text style={[feedbackStyles.label, { color: colors.textSecondary }]}>
                {feedbackType === "shiur_request" ? "Shiur / Speaker Name" : "What went wrong?"}
              </Text>
              <TextInput
                style={[feedbackStyles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                placeholder={feedbackType === "shiur_request" ? "e.g. Rabbi Ploni - Gemara Shiur" : "e.g. Audio stops playing"}
                placeholderTextColor={colors.textSecondary}
                value={feedbackSubject}
                onChangeText={setFeedbackSubject}
                maxLength={200}
              />

              <Text style={[feedbackStyles.label, { color: colors.textSecondary }]}>Details</Text>
              <TextInput
                style={[feedbackStyles.input, feedbackStyles.textArea, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                placeholder={feedbackType === "shiur_request"
                  ? "Any details about where to find this shiur, RSS feed link, etc."
                  : "Please describe the issue in detail. What were you doing when it happened?"}
                placeholderTextColor={colors.textSecondary}
                value={feedbackMessage}
                onChangeText={setFeedbackMessage}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                maxLength={5000}
              />

              <Text style={[feedbackStyles.label, { color: colors.textSecondary }]}>Contact Info (optional)</Text>
              <TextInput
                style={[feedbackStyles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                placeholder="Email or phone if you'd like a response"
                placeholderTextColor={colors.textSecondary}
                value={feedbackContact}
                onChangeText={setFeedbackContact}
                maxLength={200}
                autoCapitalize="none"
              />

              <Pressable
                style={[feedbackStyles.submitBtn, { backgroundColor: colors.accent, opacity: feedbackSending ? 0.6 : 1 }]}
                onPress={handleSubmitFeedback}
                disabled={feedbackSending}
              >
                {feedbackSending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={feedbackStyles.submitBtnText}>Submit</Text>
                )}
              </Pressable>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <OptionPickerModal
        visible={activePicker === "episodeLimit"}
        title="Episodes Per Shiur"
        subtitle="Choose how many episodes to keep downloaded per shiur."
        options={EPISODE_LIMIT_OPTIONS.map(n => ({
          label: `${n} episodes`,
          onPress: () => updateSettings({ maxEpisodesPerFeed: n }),
          selected: settings.maxEpisodesPerFeed === n,
        }))}
        onClose={() => setActivePicker(null)}
      />

      <OptionPickerModal
        visible={activePicker === "skipForward"}
        title="Skip Forward"
        subtitle="Choose skip forward duration."
        options={SKIP_OPTIONS.map(n => ({
          label: `${n} seconds`,
          onPress: () => updateSettings({ skipForwardSeconds: n }),
          selected: settings.skipForwardSeconds === n,
        }))}
        onClose={() => setActivePicker(null)}
      />

      <OptionPickerModal
        visible={activePicker === "skipBackward"}
        title="Skip Backward"
        subtitle="Choose skip backward duration."
        options={SKIP_OPTIONS.map(n => ({
          label: `${n} seconds`,
          onPress: () => updateSettings({ skipBackwardSeconds: n }),
          selected: settings.skipBackwardSeconds === n,
        }))}
        onClose={() => setActivePicker(null)}
      />

      <OptionPickerModal
        visible={activePicker === "theme"}
        title="Theme"
        subtitle="Choose app theme."
        options={THEME_OPTIONS.map(t => ({
          label: THEME_LABELS[t],
          onPress: () => updateSettings({ darkModeOverride: t }),
          selected: settings.darkModeOverride === t,
        }))}
        onClose={() => setActivePicker(null)}
      />

      <OptionPickerModal
        visible={activePicker === "reminderHour"}
        title="Reminder Time"
        subtitle="Choose when to receive daily reminders."
        options={REMINDER_HOUR_OPTIONS.map(h => ({
          label: formatHour(h),
          onPress: () => updateSettings({ dailyReminderHour: h }),
          selected: settings.dailyReminderHour === h,
        }))}
        onClose={() => setActivePicker(null)}
      />
    </ScrollView>
  );
}

export default function SettingsScreen() {
  return (
    <ErrorBoundary>
      <SettingsScreenInner />
    </ErrorBoundary>
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

const feedbackStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modal: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: Platform.OS === "web" ? 34 : 40,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
  },
  textArea: {
    minHeight: 100,
  },
  submitBtn: {
    marginTop: 20,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
