// YTC: shiur-update email subscription screen.
//
// Mirrors the website's /subscriptions page (verified against
// github.com/abbrach1/YTC-ALUMNI-MAIN-WEBSITE → app/subscriptions/page.tsx).
//
// Persists to Firestore at `subscriptions/{user.uid}` — top-level
// collection, NOT nested under users/. The website's
// /api/notify-new-shiur reads from this same collection on every new
// shiur upload and emails users whose `rebbeim` or `tags` overlap.
//
// No master enable switch (matches the website). Empty arrays = no
// emails. The picks themselves are the toggle.
//
// Reachable from the home screen's profile menu ("Email Updates").
// Lives outside the (tabs) group so it takes the full screen with its
// own floating-X back button (rendered by app/ytc/_layout.tsx — same
// as /ytc/settings).

import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Platform, TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { useYtcAuth } from "@/contexts/YtcAuthContext";
import {
  getSubs, setSubs, toggleRebbe, toggleTag, hydrateSubs, getShiurOptions,
  type ShiurEmailSubs, type ShiurOptions,
} from "@/lib/ytc/email-subscriptions";

export default function YtcEmailUpdatesScreen() {
  const { user } = useYtcAuth();
  const [subs, setLocal] = useState<ShiurEmailSubs | null>(null);
  const [options, setOptions] = useState<ShiurOptions>({ rebbeim: [], tags: [], series: [] });
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [tagFilter, setTagFilter] = useState("");
  const [openSection, setOpenSection] = useState<"rebbeim" | "tags" | null>(null);

  useEffect(() => {
    // Pull current picks first from local cache, then hydrate from
    // Firestore so a website-side change shows up here.
    (async () => {
      const cur = await getSubs();
      setLocal(cur);
      hydrateSubs().then(getSubs).then(setLocal).catch(() => {});
    })();
    // Pick-options come from the admin-curated `settings/shiurOptions`
    // doc — same source the website uses. Do NOT derive from the
    // shiurim collection or the lists will drift from the website.
    getShiurOptions()
      .then(setOptions)
      .finally(() => setLoadingOptions(false));
  }, []);

  const onToggleRebbe = async (name: string) => {
    setLocal((s) => {
      if (!s) return s;
      const has = s.rebbeim.includes(name);
      return { ...s, rebbeim: has ? s.rebbeim.filter((r) => r !== name) : [...s.rebbeim, name] };
    });
    try { await toggleRebbe(name); } catch {}
  };

  const onToggleTag = async (tag: string) => {
    setLocal((s) => {
      if (!s) return s;
      const has = s.tags.includes(tag);
      return { ...s, tags: has ? s.tags.filter((t) => t !== tag) : [...s.tags, tag] };
    });
    try { await toggleTag(tag); } catch {}
  };

  const clearRebbeim = async () => {
    setLocal((s) => s ? { ...s, rebbeim: [] } : s);
    try { await setSubs({ rebbeim: [] }); } catch {}
  };
  const clearTags = async () => {
    setLocal((s) => s ? { ...s, tags: [] } : s);
    try { await setSubs({ tags: [] }); } catch {}
  };

  const filteredTags = useMemo(() => {
    const q = tagFilter.trim().toLowerCase();
    if (!q) return options.tags;
    return options.tags.filter((t) => t.toLowerCase().includes(q));
  }, [options.tags, tagFilter]);

  if (!subs) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      </SafeAreaView>
    );
  }

  const totalSelected = subs.rebbeim.length + subs.tags.length;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Email Updates</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 80 }}>
        <View style={styles.intro}>
          <Ionicons name="notifications-outline" size={20} color={Colors.navy} />
          <Text style={styles.introText}>
            Pick the rebbeim and topics you want to follow. We'll email{" "}
            {user?.email ? <Text style={styles.introEmphasis}>{user.email}</Text> : "you"} whenever a matching shiur is uploaded.
          </Text>
        </View>

        {/* Rebbeim — accordion. Header shows pick count + clear shortcut. */}
        <Text style={styles.sectionTitle}>Rebbeim ({subs.rebbeim.length} selected)</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => setOpenSection(openSection === "rebbeim" ? null : "rebbeim")}
            activeOpacity={0.7}
          >
            <Text style={styles.accordionLabel}>
              {openSection === "rebbeim" ? "Hide list" : "Choose rebbeim"}
            </Text>
            {subs.rebbeim.length > 0 && (
              <TouchableOpacity onPress={clearRebbeim} hitSlop={8}>
                <Text style={styles.clearLink}>Clear</Text>
              </TouchableOpacity>
            )}
            <Ionicons
              name={openSection === "rebbeim" ? "chevron-up" : "chevron-down"}
              size={18}
              color={Colors.navyOpacity50}
            />
          </TouchableOpacity>
          {openSection === "rebbeim" && (
            loadingOptions ? (
              <View style={{ padding: 16, alignItems: "center" }}>
                <ActivityIndicator size="small" color={Colors.navy} />
              </View>
            ) : options.rebbeim.length === 0 ? (
              <Text style={styles.emptyText}>No rebbeim available yet.</Text>
            ) : (
              <View style={styles.chipGrid}>
                {options.rebbeim.map((name) => {
                  const checked = subs.rebbeim.includes(name);
                  return (
                    <TouchableOpacity
                      key={name}
                      style={[styles.chip, checked && styles.chipActive]}
                      onPress={() => onToggleRebbe(name)}
                    >
                      <Text style={[styles.chipText, checked && styles.chipTextActive]}>{name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )
          )}
        </View>

        {/* Topics (Firestore field name is `tags` — kept the user-facing
            label "Topics" since that's what the website shows). */}
        <Text style={styles.sectionTitle}>Topics ({subs.tags.length} selected)</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => setOpenSection(openSection === "tags" ? null : "tags")}
            activeOpacity={0.7}
          >
            <Text style={styles.accordionLabel}>
              {openSection === "tags" ? "Hide list" : "Choose topics"}
            </Text>
            {subs.tags.length > 0 && (
              <TouchableOpacity onPress={clearTags} hitSlop={8}>
                <Text style={styles.clearLink}>Clear</Text>
              </TouchableOpacity>
            )}
            <Ionicons
              name={openSection === "tags" ? "chevron-up" : "chevron-down"}
              size={18}
              color={Colors.navyOpacity50}
            />
          </TouchableOpacity>
          {openSection === "tags" && (
            <>
              <View style={styles.searchBox}>
                <Ionicons name="search" size={14} color={Colors.navyOpacity50} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search topics..."
                  placeholderTextColor={Colors.navyOpacity50}
                  value={tagFilter}
                  onChangeText={setTagFilter}
                />
                {tagFilter ? (
                  <TouchableOpacity onPress={() => setTagFilter("")}>
                    <Ionicons name="close-circle" size={16} color={Colors.navyOpacity50} />
                  </TouchableOpacity>
                ) : null}
              </View>
              {loadingOptions ? (
                <View style={{ padding: 16, alignItems: "center" }}>
                  <ActivityIndicator size="small" color={Colors.navy} />
                </View>
              ) : filteredTags.length === 0 ? (
                <Text style={styles.emptyText}>
                  {options.tags.length === 0 ? "No topics available yet." : "No matching topics."}
                </Text>
              ) : (
                <View style={styles.chipGrid}>
                  {filteredTags.map((tag) => {
                    const checked = subs.tags.includes(tag);
                    return (
                      <TouchableOpacity
                        key={tag}
                        style={[styles.chip, checked && styles.chipActive]}
                        onPress={() => onToggleTag(tag)}
                      >
                        <Text style={[styles.chipText, checked && styles.chipTextActive]}>{tag}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            {totalSelected === 0
              ? "No subscriptions selected — you won't receive emails."
              : `${totalSelected} subscription${totalSelected === 1 ? "" : "s"} active. Changes save automatically.`}
          </Text>
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
  intro: {
    flexDirection: "row", gap: 10, alignItems: "flex-start",
    marginHorizontal: 12, marginTop: 16, padding: 14, borderRadius: 12,
    backgroundColor: Colors.white,
    borderWidth: 1, borderColor: Colors.goldOpacity30,
  },
  introText: { flex: 1, fontSize: 13, color: Colors.navyOpacity70, lineHeight: 18 },
  introEmphasis: { color: Colors.navy, fontWeight: "600" },
  sectionTitle: {
    fontSize: 12, fontWeight: "600", color: Colors.navyOpacity70, textTransform: "uppercase",
    letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6,
  },
  card: {
    backgroundColor: Colors.white, marginHorizontal: 12, borderRadius: 12, overflow: "hidden",
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 3, elevation: 1,
  },
  accordionHeader: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10,
  },
  accordionLabel: { flex: 1, fontSize: 14, color: Colors.navy, fontWeight: "600" },
  clearLink: { fontSize: 12, color: Colors.navyOpacity70, textDecorationLine: "underline" },
  searchBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.cream, borderRadius: 8, marginHorizontal: 10, marginTop: 2, marginBottom: 8,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  searchInput: { flex: 1, fontSize: 13, color: Colors.navy, paddingVertical: 0 },
  chipGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10, paddingTop: 0 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
    backgroundColor: Colors.cream, borderWidth: 1, borderColor: Colors.goldOpacity30,
  },
  chipActive: { backgroundColor: Colors.navy, borderColor: Colors.navy },
  chipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  chipTextActive: { color: Colors.cream },
  emptyText: { fontSize: 13, color: Colors.navyOpacity50, padding: 16, fontStyle: "italic" },
  footer: { paddingHorizontal: 16, paddingTop: 16 },
  footerText: { fontSize: 11, color: Colors.navyOpacity50, lineHeight: 16, textAlign: "center" },
});
