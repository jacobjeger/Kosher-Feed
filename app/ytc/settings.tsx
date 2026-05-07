// YTC: download settings page. Pushed onto the YTC modal stack from the
// home tab's gear icon. Lives outside the (tabs) group so it takes the
// full screen with its own back button — this is a deeper-than-tabs
// surface, not a peer.
//
// What it controls (lib/ytc/downloads.ts):
//   - Auto-download mode: Off | All | Selected rebbeim
//   - Selected rebbeim list (lazy-loaded from the shiurim collection)
//   - Max-items cap (50 / 100 / 250 / Unlimited) — enforces eviction
//     so a long-running "All" mode can't fill the device
//   - Wi-Fi only toggle
//
// "Run now" triggers runYtcAutoDownload immediately so the user can
// test settings without waiting for the next home-screen mount.
import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch,
  ActivityIndicator, Platform, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import {
  getYtcDownloadSettings, setYtcDownloadSettings, listAllRebbeim,
  runYtcAutoDownload, getYtcDownloads, deleteAllYtcDownloads,
  type YtcAutoDownloadMode, type YtcDownloadSettings, type AutoDownloadResult,
} from "@/lib/ytc/downloads";
import { useDownloads } from "@/contexts/DownloadsContext";
import {
  getMasterPrefs, setMasterPref, getSubscribedRebbeim, isRebbeSubscribed,
  subscribeToRebbe, unsubscribeFromRebbe, isYtcPushConfigured, rebbeTopic,
  type DefaultTopic,
} from "@/lib/ytc/push";
import { fetchRebbeim } from "@/lib/ytc/firebase";
import type { Rebbe } from "@/types/ytc";

const MAX_ITEM_OPTIONS: { label: string; value: number }[] = [
  { label: "50",        value: 50 },
  { label: "100",       value: 100 },
  { label: "250",       value: 250 },
  { label: "Unlimited", value: -1 },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const AUTO_DELETE_OPTIONS: { label: string; value: number }[] = [
  { label: "Off",     value: 0 },
  { label: "1 day",   value: 1 * DAY },
  { label: "2 days",  value: 2 * DAY },
  { label: "7 days",  value: 7 * DAY },
  { label: "30 days", value: 30 * DAY },
];

export default function YtcSettingsScreen() {
  const downloadsCtx = useDownloads();
  const [settings, setSettings] = useState<YtcDownloadSettings | null>(null);
  const [rebbeim, setRebbeim] = useState<string[]>([]);
  const [rebbeimLoading, setRebbeimLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<AutoDownloadResult | null>(null);

  // Push state
  const [pushConfigured, setPushConfigured] = useState(false);
  const [masterPrefs, setMasterPrefs] = useState<{ announcements: boolean; new_shiurim: boolean; simchas: boolean; events: boolean } | null>(null);
  const [pushRebbeim, setPushRebbeim] = useState<Rebbe[]>([]);
  const [subscribedRebbeTopics, setSubscribedRebbeTopics] = useState<Set<string>>(new Set());

  useEffect(() => {
    getYtcDownloadSettings().then(setSettings);
    listAllRebbeim()
      .then(setRebbeim)
      .catch(() => setRebbeim([]))
      .finally(() => setRebbeimLoading(false));
    isYtcPushConfigured().then(setPushConfigured);
    getMasterPrefs().then(setMasterPrefs);
    getSubscribedRebbeim().then((arr) => setSubscribedRebbeTopics(new Set(arr)));
    fetchRebbeim().then((r) => setPushRebbeim(r as Rebbe[])).catch(() => {});
  }, []);

  const ytcDownloadCount = useMemo(
    () => getYtcDownloads(downloadsCtx).length,
    [downloadsCtx.downloads],
  );

  const update = async (patch: Partial<YtcDownloadSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await setYtcDownloadSettings(next);
  };

  const toggleRebbe = async (name: string) => {
    if (!settings) return;
    const has = settings.selectedRebbeim.includes(name);
    const nextList = has
      ? settings.selectedRebbeim.filter((r) => r !== name)
      : [...settings.selectedRebbeim, name];
    await update({ selectedRebbeim: nextList });
  };

  const runNow = async () => {
    if (!settings || running) return;
    if (settings.mode === "off") {
      Alert.alert("Auto-download is off", "Pick All or Selected to choose what to download.");
      return;
    }
    setRunning(true);
    const result = await runYtcAutoDownload(downloadsCtx);
    setLastResult(result);
    setRunning(false);
  };

  const togglePushMaster = async (topic: DefaultTopic, value: boolean) => {
    if (!masterPrefs) return;
    // Optimistic.
    setMasterPrefs({ ...masterPrefs, [topic]: value });
    try { await setMasterPref(topic, value); }
    catch {
      setMasterPrefs({ ...masterPrefs }); // rollback to previous state
      Alert.alert("Couldn't update", "Please try again.");
    }
  };

  const togglePushRebbe = async (name: string) => {
    const t = rebbeTopic(name);
    const wasSubscribed = subscribedRebbeTopics.has(t);
    // Optimistic.
    const next = new Set(subscribedRebbeTopics);
    if (wasSubscribed) next.delete(t); else next.add(t);
    setSubscribedRebbeTopics(next);
    try {
      if (wasSubscribed) await unsubscribeFromRebbe(name);
      else await subscribeToRebbe(name);
    } catch {
      // Rollback.
      const back = new Set(subscribedRebbeTopics);
      setSubscribedRebbeTopics(back);
      Alert.alert("Couldn't update", "Please try again.");
    }
  };

  const deleteAll = async () => {
    if (ytcDownloadCount === 0) return;
    Alert.alert(
      "Delete all YTC downloads?",
      `This removes ${ytcDownloadCount} downloaded shiurim from this device. Your auto-download settings stay as-is.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete all", style: "destructive",
          onPress: async () => { await deleteAllYtcDownloads(downloadsCtx); },
        },
      ],
    );
  };

  if (!settings) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Back navigation is handled by the floating X at top-left
           (rendered by app/ytc/_layout.tsx). It calls router.back(),
           which pops this stack frame back to /ytc/(tabs). Don't add
           a second back affordance here — they overlap geometrically. */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Download Settings</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 80 }}>

        <Text style={styles.sectionTitle}>Notifications</Text>
        {!pushConfigured && (
          <View style={styles.warnCard}>
            <Ionicons name="alert-circle-outline" size={20} color={Colors.error} />
            <Text style={styles.warnText}>
              Push notifications are pending Firebase setup. The toggles save your preference but won't deliver until the app is built with the YTC project's google-services.json.
            </Text>
          </View>
        )}
        {masterPrefs && (
          <View style={styles.card}>
            {([
              ["announcements", "Announcements", "General announcements from the yeshiva"],
              ["new_shiurim", "New Shiurim", "Get notified for every new shiur posted"],
              ["simchas", "Simchas & Mazel Tovs", "When fellow alumni share simchas"],
              ["events", "Events", "Yeshiva events"],
            ] as Array<[DefaultTopic, string, string]>).map(([topic, label, sub]) => (
              <View key={topic} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{label}</Text>
                  <Text style={styles.rowSubtitleInline}>{sub}</Text>
                </View>
                <Switch
                  value={masterPrefs[topic]}
                  onValueChange={(v) => togglePushMaster(topic, v)}
                  trackColor={{ false: Colors.navyOpacity30, true: Colors.gold }}
                  thumbColor={Platform.OS === "android" ? Colors.cream : undefined}
                />
              </View>
            ))}
          </View>
        )}

        {pushRebbeim.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Per-rebbe notifications</Text>
            <View style={styles.card}>
              {pushRebbeim.map((r) => {
                const subscribed = subscribedRebbeTopics.has(rebbeTopic(r.name));
                return (
                  <View key={r.id} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{r.name}</Text>
                      {r.title ? <Text style={styles.rowSubtitleInline}>{r.title}</Text> : null}
                    </View>
                    <Switch
                      value={subscribed}
                      onValueChange={() => togglePushRebbe(r.name)}
                      trackColor={{ false: Colors.navyOpacity30, true: Colors.gold }}
                      thumbColor={Platform.OS === "android" ? Colors.cream : undefined}
                    />
                  </View>
                );
              })}
            </View>
          </>
        )}

        <Text style={styles.sectionTitle}>Auto-download</Text>
        <View style={styles.card}>
          {(["off", "all", "selected"] as YtcAutoDownloadMode[]).map((mode) => (
            <TouchableOpacity
              key={mode}
              style={styles.row}
              onPress={() => update({ mode })}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>
                  {mode === "off" ? "Off" : mode === "all" ? "All new shiurim" : "Selected rebbeim only"}
                </Text>
                <Text style={styles.rowSubtitle}>
                  {mode === "off"
                    ? "Don't download anything automatically"
                    : mode === "all"
                    ? "Queue every new shiur from every rebbe"
                    : "Pick which rebbeim to follow"}
                </Text>
              </View>
              <Ionicons
                name={settings.mode === mode ? "radio-button-on" : "radio-button-off"}
                size={22}
                color={settings.mode === mode ? Colors.gold : Colors.navyOpacity50}
              />
            </TouchableOpacity>
          ))}
        </View>

        {settings.mode === "selected" && (
          <>
            <Text style={styles.sectionTitle}>Rebbeim ({settings.selectedRebbeim.length} selected)</Text>
            <View style={styles.card}>
              {rebbeimLoading ? (
                <View style={{ padding: 16, alignItems: "center" }}>
                  <ActivityIndicator size="small" color={Colors.navy} />
                </View>
              ) : rebbeim.length === 0 ? (
                <Text style={styles.emptyText}>No rebbeim found in the shiurim collection.</Text>
              ) : (
                rebbeim.map((name) => {
                  const checked = settings.selectedRebbeim.includes(name);
                  return (
                    <TouchableOpacity key={name} style={styles.row} onPress={() => toggleRebbe(name)}>
                      <Text style={[styles.rowTitle, { flex: 1 }]} numberOfLines={1}>{name}</Text>
                      <Ionicons
                        name={checked ? "checkbox" : "square-outline"}
                        size={22}
                        color={checked ? Colors.gold : Colors.navyOpacity50}
                      />
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </>
        )}

        <Text style={styles.sectionTitle}>Storage limit</Text>
        <View style={styles.card}>
          <View style={styles.rowChips}>
            {MAX_ITEM_OPTIONS.map((opt) => {
              const active = settings.maxItems === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => update({ maxItems: opt.value })}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.rowSubtitle}>
            Keep at most this many shiurim downloaded. Oldest are auto-removed when over the cap.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Auto-delete after listening</Text>
        <View style={styles.card}>
          <View style={styles.rowChips}>
            {AUTO_DELETE_OPTIONS.map((opt) => {
              const active = settings.autoDeleteAfterMs === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => update({ autoDeleteAfterMs: opt.value })}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.rowSubtitle}>
            Once a shiur plays through, remove the downloaded file after this delay. Off keeps every downloaded shiur until you delete it manually.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Network</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Wi-Fi only</Text>
              <Text style={styles.rowSubtitle}>Skip auto-download on cellular</Text>
            </View>
            <Switch
              value={settings.wifiOnly}
              onValueChange={(v) => update({ wifiOnly: v })}
              trackColor={{ false: Colors.navyOpacity30, true: Colors.gold }}
              thumbColor={Platform.OS === "android" ? Colors.cream : undefined}
            />
          </View>
        </View>

        <Text style={styles.sectionTitle}>Status</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowTitle}>Currently downloaded</Text>
            <Text style={styles.rowValue}>{ytcDownloadCount}</Text>
          </View>
          {lastResult && (
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>Last run</Text>
                <Text style={styles.rowSubtitle}>
                  {lastResult.skippedReason
                    ? `Skipped (${lastResult.skippedReason})`
                    : `Queued ${lastResult.queued}, already had ${lastResult.alreadyHave}, evicted ${lastResult.evicted}`}
                </Text>
              </View>
            </View>
          )}
          <TouchableOpacity style={[styles.runBtn, running && styles.runBtnDisabled]} onPress={runNow} disabled={running}>
            {running
              ? <ActivityIndicator size="small" color={Colors.cream} />
              : <Text style={styles.runBtnText}>Run auto-download now</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.deleteAllBtn, ytcDownloadCount === 0 && styles.runBtnDisabled]}
            onPress={deleteAll}
            disabled={ytcDownloadCount === 0}
          >
            <Ionicons name="trash-outline" size={16} color={Colors.error} />
            <Text style={styles.deleteAllBtnText}>Delete all downloaded shiurim</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  loader: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    backgroundColor: Colors.navy, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10,
    alignItems: "center",
  },
  headerTitle: { color: Colors.cream, fontSize: 16, fontWeight: "600", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  scroll: { flex: 1 },
  sectionTitle: {
    fontSize: 12, fontWeight: "600", color: Colors.navyOpacity70, textTransform: "uppercase",
    letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6,
  },
  card: {
    backgroundColor: Colors.white, marginHorizontal: 12, borderRadius: 12, overflow: "hidden",
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 3, elevation: 1,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.creamDark, gap: 10,
  },
  rowTitle: { fontSize: 14, color: Colors.navy, fontWeight: "500" },
  rowSubtitle: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2, paddingHorizontal: 14, paddingBottom: 10 },
  rowSubtitleInline: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  warnCard: {
    flexDirection: "row", gap: 8, alignItems: "flex-start",
    marginHorizontal: 12, padding: 12, borderRadius: 10,
    backgroundColor: "rgba(220, 38, 38, 0.08)",
    borderWidth: 1, borderColor: "rgba(220, 38, 38, 0.2)",
  },
  warnText: { flex: 1, fontSize: 12, color: Colors.navy, lineHeight: 17 },
  rowValue: { fontSize: 14, color: Colors.navy, fontWeight: "600" },
  rowChips: { flexDirection: "row", gap: 8, padding: 12, flexWrap: "wrap" },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: Colors.creamDark },
  chipActive: { backgroundColor: Colors.navy },
  chipText: { fontSize: 13, color: Colors.navy, fontWeight: "500" },
  chipTextActive: { color: Colors.cream },
  runBtn: {
    margin: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: Colors.navy,
    alignItems: "center", justifyContent: "center",
  },
  runBtnDisabled: { opacity: 0.5 },
  runBtnText: { color: Colors.cream, fontSize: 14, fontWeight: "600" },
  deleteAllBtn: {
    marginHorizontal: 12, marginBottom: 12, paddingVertical: 12, borderRadius: 10,
    backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.error,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  deleteAllBtnText: { color: Colors.error, fontSize: 14, fontWeight: "600" },
  emptyText: { fontSize: 13, color: Colors.navyOpacity70, padding: 16 },
});
