// YTC: shiur-update email subscription screen.
//
// Lets the user pick which rebbeim + which topics they want
// new-shiur emails for. Server-side trigger reads the resulting
// users/{uid}/preferences/shiurEmailSubscriptions doc and emails the
// user when a freshly uploaded shiur matches any of their picks.
//
// Reachable from the home screen's profile menu ("Email updates"). Lives
// outside the (tabs) group so it takes the full screen with its own
// floating-X back button (rendered by app/ytc/_layout.tsx — same as
// /ytc/settings).
//
// Force-light styling (matches the website's profile-page look). The
// global YTC theme toggle lives on /ytc/settings, not here.

import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch,
  ActivityIndicator, Platform, TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { useYtcAuth } from "@/contexts/YtcAuthContext";
import { fetchShiurim } from "@/lib/ytc/firebase";
import type { Shiur } from "@/types/ytc";
import {
  getSubs, setSubs, toggleRebbe, toggleTopic, hydrateSubs,
  type ShiurEmailSubs,
} from "@/lib/ytc/email-subscriptions";

export default function YtcEmailUpdatesScreen() {
  const { user } = useYtcAuth();
  const [subs, setLocal] = useState<ShiurEmailSubs | null>(null);
  const [allRebbeim, setAllRebbeim] = useState<string[]>([]);
  const [allTopics, setAllTopics] = useState<string[]>([]);
  const [loadingTaxonomy, setLoadingTaxonomy] = useState(true);
  const [topicFilter, setTopicFilter] = useState("");
  const [openSection, setOpenSection] = useState<"rebbeim" | "topics" | null>(null);

  useEffect(() => {
    // Pull current prefs first from local cache, then hydrate from
    // Firestore so a website-side change shows up here.
    (async () => {
      const cur = await getSubs();
      setLocal(cur);
      hydrateSubs().then(getSubs).then(setLocal).catch(() => {});
    })();
    // Build the rebbe + topic taxonomy from the shiurim collection so
    // the lists stay in sync with what the backend can match against.
    (async () => {
      try {
        const data = (await fetchShiurim()) as Shiur[];
        const rebbeim = Array.from(new Set(data.map((s) => s.rebbe).filter(Boolean))).sort();
        const topics = Array.from(new Set(data.flatMap((s) => s.tags ?? []).filter(Boolean))).sort();
        setAllRebbeim(rebbeim);
        setAllTopics(topics);
      } catch {
        setAllRebbeim([]); setAllTopics([]);
      } finally { setLoadingTaxonomy(false); }
    })();
  }, []);

  const setMaster = async (enabled: boolean) => {
    setLocal((s) => s ? { ...s, enabled } : s);
    try { await setSubs({ enabled }); } catch {}
  };

  const onToggleRebbe = async (name: string) => {
    setLocal((s) => {
      if (!s) return s;
      const has = s.rebbeim.includes(name);
      return { ...s, rebbeim: has ? s.rebbeim.filter((r) => r !== name) : [...s.rebbeim, name] };
    });
    try { await toggleRebbe(name); } catch {}
  };

  const onToggleTopic = async (tag: string) => {
    setLocal((s) => {
      if (!s) return s;
      const has = s.topics.includes(tag);
      return { ...s, topics: has ? s.topics.filter((t) => t !== tag) : [...s.topics, tag] };
    });
    try { await toggleTopic(tag); } catch {}
  };

  const filteredTopics = useMemo(() => {
    const q = topicFilter.trim().toLowerCase();
    if (!q) return allTopics;
    return allTopics.filter((t) => t.toLowerCase().includes(q));
  }, [allTopics, topicFilter]);

  if (!subs) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Email Updates</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 80 }}>
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <Text style={styles.bodyText}>
            Get an email when a new shiur is uploaded that matches your selected rebbeim or topics. Manage the same picks on the website at alumni.ytchaim.com — they sync to your account.
          </Text>
          {!!user?.email && (
            <Text style={[styles.bodyText, { marginTop: 6 }]}>
              Sending to: <Text style={styles.bodyEmphasis}>{user.email}</Text>
            </Text>
          )}
        </View>

        <Text style={styles.sectionTitle}>Master switch</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Email me when a new shiur is uploaded</Text>
              <Text style={styles.rowSubtitleInline}>You'll only receive emails for the rebbeim + topics you pick below.</Text>
            </View>
            <Switch
              value={subs.enabled}
              onValueChange={setMaster}
              trackColor={{ false: Colors.navyOpacity30, true: Colors.gold }}
              thumbColor={Platform.OS === "android" ? Colors.cream : undefined}
            />
          </View>
        </View>

        {/* Rebbeim accordion */}
        <Text style={styles.sectionTitle}>Rebbeim ({subs.rebbeim.length} selected)</Text>
        <TouchableOpacity
          style={[styles.card, styles.accordionHeader]}
          onPress={() => setOpenSection(openSection === "rebbeim" ? null : "rebbeim")}
          activeOpacity={0.7}
        >
          <Text style={styles.accordionLabel}>
            {openSection === "rebbeim" ? "Hide list" : "Choose rebbeim"}
          </Text>
          <Ionicons
            name={openSection === "rebbeim" ? "chevron-up" : "chevron-down"}
            size={18}
            color={Colors.navyOpacity50}
          />
        </TouchableOpacity>
        {openSection === "rebbeim" && (
          <View style={styles.card}>
            {loadingTaxonomy ? (
              <View style={{ padding: 16, alignItems: "center" }}>
                <ActivityIndicator size="small" color={Colors.navy} />
              </View>
            ) : allRebbeim.length === 0 ? (
              <Text style={styles.emptyText}>No rebbeim found.</Text>
            ) : (
              allRebbeim.map((name) => {
                const checked = subs.rebbeim.includes(name);
                return (
                  <TouchableOpacity key={name} style={styles.row} onPress={() => onToggleRebbe(name)}>
                    <Text style={[styles.rowTitle, { flex: 1 }]} numberOfLines={1}>{name}</Text>
                    <Ionicons
                      name={checked ? "checkbox" : "square-outline"}
                      size={20}
                      color={checked ? Colors.gold : Colors.navyOpacity50}
                    />
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}

        {/* Topics accordion */}
        <Text style={styles.sectionTitle}>Topics ({subs.topics.length} selected)</Text>
        <TouchableOpacity
          style={[styles.card, styles.accordionHeader]}
          onPress={() => setOpenSection(openSection === "topics" ? null : "topics")}
          activeOpacity={0.7}
        >
          <Text style={styles.accordionLabel}>
            {openSection === "topics" ? "Hide list" : "Choose topics"}
          </Text>
          <Ionicons
            name={openSection === "topics" ? "chevron-up" : "chevron-down"}
            size={18}
            color={Colors.navyOpacity50}
          />
        </TouchableOpacity>
        {openSection === "topics" && (
          <View style={styles.card}>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={14} color={Colors.navyOpacity50} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search topics..."
                placeholderTextColor={Colors.navyOpacity50}
                value={topicFilter}
                onChangeText={setTopicFilter}
              />
              {topicFilter ? (
                <TouchableOpacity onPress={() => setTopicFilter("")}>
                  <Ionicons name="close-circle" size={16} color={Colors.navyOpacity50} />
                </TouchableOpacity>
              ) : null}
            </View>
            {loadingTaxonomy ? (
              <View style={{ padding: 16, alignItems: "center" }}>
                <ActivityIndicator size="small" color={Colors.navy} />
              </View>
            ) : filteredTopics.length === 0 ? (
              <Text style={styles.emptyText}>No matching topics.</Text>
            ) : (
              <View style={styles.topicGrid}>
                {filteredTopics.map((tag) => {
                  const checked = subs.topics.includes(tag);
                  return (
                    <TouchableOpacity
                      key={tag}
                      style={[styles.topicChip, checked && styles.topicChipActive]}
                      onPress={() => onToggleTopic(tag)}
                    >
                      <Text style={[styles.topicChipText, checked && styles.topicChipTextActive]}>
                        {tag}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}
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
  bodyText: { fontSize: 13, color: Colors.navyOpacity70, lineHeight: 18, padding: 14 },
  bodyEmphasis: { color: Colors.navy, fontWeight: "600" },
  row: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.creamDark, gap: 10,
  },
  rowTitle: { fontSize: 14, color: Colors.navy, fontWeight: "500" },
  rowSubtitleInline: { fontSize: 12, color: Colors.navyOpacity70, marginTop: 2 },
  accordionHeader: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10,
  },
  accordionLabel: { flex: 1, fontSize: 14, color: Colors.navy, fontWeight: "600" },
  searchBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.cream, borderRadius: 8, marginHorizontal: 10, marginTop: 10,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  searchInput: { flex: 1, fontSize: 13, color: Colors.navy, paddingVertical: 0 },
  topicGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10 },
  topicChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
    backgroundColor: Colors.creamDark,
  },
  topicChipActive: { backgroundColor: Colors.navy },
  topicChipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  topicChipTextActive: { color: Colors.cream },
  emptyText: { fontSize: 13, color: Colors.navyOpacity50, padding: 16 },
});
