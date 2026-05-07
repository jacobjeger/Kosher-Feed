// YTC: rebbeim + alumni directory. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/contacts.tsx with imports remapped.
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, SectionList, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, Linking, Platform, RefreshControl,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchRebbeim, fetchApprovedAlumni, invalidateYtcCache } from "@/lib/ytc/firebase";
import type { Rebbe, AlumniContact } from "@/types/ytc";

type ContactTab = "rebbeim" | "alumni";

export default function ContactsScreen() {
  const [rebbeim, setRebbeim] = useState<Rebbe[]>([]);
  const [alumni, setAlumni] = useState<AlumniContact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<ContactTab>("rebbeim");
  const [alumniSearch, setAlumniSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [alumniPage, setAlumniPage] = useState(1);
  const ALUMNI_PAGE_SIZE = 50;

  const loadData = async () => {
    try {
      const [r, a] = await Promise.all([fetchRebbeim(), fetchApprovedAlumni()]);
      setRebbeim(r as Rebbe[]);
      setAlumni(a as AlumniContact[]);
    } catch (e) {
      console.error("YTC Contacts load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadData(); }, []);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([invalidateYtcCache("rebbeim"), invalidateYtcCache("approvedAlumni")]);
    loadData();
  }, []);

  const filteredAlumni = alumni.filter(
    (a) =>
      alumniSearch === "" ||
      a.name.toLowerCase().includes(alumniSearch.toLowerCase()) ||
      a.location?.toLowerCase().includes(alumniSearch.toLowerCase()),
  );

  // Reset pagination when search/tab changes so the first results render fast.
  useEffect(() => { setAlumniPage(1); }, [alumniSearch, activeTab]);

  // Slice the visible window. SectionList's onEndReached bumps the page;
  // the user sees an instant first paint with up to 50 contacts and more
  // load on scroll. With ~hundreds of alumni the full-list render was the
  // slowest part of contacts; this paginates without a network round trip.
  const visibleCount = alumniPage * ALUMNI_PAGE_SIZE;
  const visibleAlumni = filteredAlumni.slice(0, visibleCount);
  const hasMoreAlumni = filteredAlumni.length > visibleCount;

  const alumniSections = Object.entries(
    visibleAlumni.reduce<Record<string, AlumniContact[]>>((acc, contact) => {
      const letter = contact.name[0]?.toUpperCase() ?? "#";
      if (!acc[letter]) acc[letter] = [];
      acc[letter].push(contact);
      return acc;
    }, {}),
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, data]) => ({ title, data }));

  const openPhone = (phone: string) => Linking.openURL(`tel:${phone}`);
  const openEmail = (email: string) => Linking.openURL(`mailto:${email}`);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Directory</Text>
        <Text style={styles.headerSubtitle}>Connect with Rebbeim and fellow alumni</Text>
      </View>

      <View style={styles.tabRow}>
        {(["rebbeim", "alumni"] as ContactTab[]).map((tab) => (
          <TouchableOpacity key={tab} style={[styles.tab, activeTab === tab && styles.tabActive]} onPress={() => setActiveTab(tab)}>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab === "rebbeim" ? "Rebbeim" : "Alumni"}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      ) : activeTab === "rebbeim" ? (
        <SectionList
          sections={[{ title: "", data: rebbeim }]}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
          contentContainerStyle={styles.listContent}
          renderItem={({ item: rebbe }) => (
            <View style={styles.rebbeCard}>
              {rebbe.photoUrl
                ? <Image source={{ uri: rebbe.photoUrl }} style={styles.rebbePhoto} contentFit="cover" />
                : <View style={styles.rebbePhotoPlaceholder}><Text style={styles.rebbeInitial}>{rebbe.name[0]}</Text></View>}
              <View style={styles.rebbeInfo}>
                <Text style={styles.rebbeName}>{rebbe.name}</Text>
                <Text style={styles.rebbeTitle}>{rebbe.title}</Text>
                <View style={styles.contactBtns}>
                  {rebbe.email && (
                    <TouchableOpacity style={styles.contactBtn} onPress={() => openEmail(rebbe.email!)}>
                      <Ionicons name="mail-outline" size={16} color={Colors.navy} />
                      <Text style={styles.contactBtnText}>Email</Text>
                    </TouchableOpacity>
                  )}
                  {rebbe.phone && (
                    <TouchableOpacity style={styles.contactBtn} onPress={() => openPhone(rebbe.phone!)}>
                      <Ionicons name="call-outline" size={16} color={Colors.navy} />
                      <Text style={styles.contactBtnText}>Call</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          )}
          ListEmptyComponent={<EmptyState message="No rebbeim found" />}
          renderSectionHeader={() => null}
        />
      ) : (
        <>
          <View style={styles.searchRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={16} color={Colors.navyOpacity50} style={{ marginRight: 8 }} />
              <TextInput style={styles.searchInput} placeholder="Search alumni..." placeholderTextColor={Colors.navyOpacity50} value={alumniSearch} onChangeText={setAlumniSearch} />
              {alumniSearch ? <TouchableOpacity onPress={() => setAlumniSearch("")}><Ionicons name="close-circle" size={18} color={Colors.navyOpacity50} /></TouchableOpacity> : null}
            </View>
          </View>
          <SectionList
            sections={alumniSections}
            keyExtractor={(item) => item.id}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
            contentContainerStyle={styles.listContent}
            stickySectionHeadersEnabled
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}><Text style={styles.sectionHeaderText}>{section.title}</Text></View>
            )}
            renderItem={({ item: contact }) => {
              const isExpanded = expandedId === contact.id;
              return (
                <TouchableOpacity style={styles.alumniCard} onPress={() => setExpandedId(isExpanded ? null : contact.id)}>
                  <View style={styles.alumniRow}>
                    <View style={styles.alumniAvatar}><Text style={styles.alumniAvatarText}>{contact.name[0]}</Text></View>
                    <View style={styles.alumniInfo}>
                      <Text style={styles.alumniName}>{contact.name}</Text>
                      {contact.location && <Text style={styles.alumniLocation}>📍 {contact.location}</Text>}
                    </View>
                    <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={16} color={Colors.navyOpacity50} />
                  </View>
                  {isExpanded && (
                    <View style={styles.alumniExpanded}>
                      <View style={styles.contactBtns}>
                        {contact.email && (
                          <TouchableOpacity style={styles.contactBtn} onPress={() => openEmail(contact.email!)}>
                            <Ionicons name="mail-outline" size={16} color={Colors.navy} />
                            <Text style={styles.contactBtnText}>{contact.email}</Text>
                          </TouchableOpacity>
                        )}
                        {contact.phone && (
                          <TouchableOpacity style={styles.contactBtn} onPress={() => openPhone(contact.phone!)}>
                            <Ionicons name="call-outline" size={16} color={Colors.navy} />
                            <Text style={styles.contactBtnText}>{contact.phone}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={<EmptyState message="No alumni found" />}
            onEndReachedThreshold={0.5}
            onEndReached={() => { if (hasMoreAlumni) setAlumniPage((p) => p + 1); }}
            ListFooterComponent={hasMoreAlumni ? (
              <View style={styles.loadMoreFooter}>
                <ActivityIndicator size="small" color={Colors.navy} />
                <Text style={styles.loadMoreText}>Loading more…</Text>
              </View>
            ) : null}
          />
        </>
      )}
    </SafeAreaView>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="person-outline" size={40} color={Colors.navyOpacity30} />
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  header: { backgroundColor: Colors.navy, paddingTop: 8, paddingBottom: 10, alignItems: "center" },
  headerTitle: { color: Colors.cream, fontSize: 18, fontWeight: "bold", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  headerSubtitle: { color: Colors.creamOpacity70, fontSize: 12, marginTop: 2 },
  tabRow: { flexDirection: "row", backgroundColor: Colors.white, padding: 6, margin: 12, borderRadius: 12, shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  tab: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 8 },
  tabActive: { backgroundColor: Colors.navy },
  tabText: { fontSize: 14, fontWeight: "500", color: Colors.navyOpacity70 },
  tabTextActive: { color: Colors.cream },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  listContent: { padding: 12, paddingBottom: 120 },
  searchRow: { paddingHorizontal: 12, paddingBottom: 8 },
  searchBox: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.white, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: Colors.creamDark },
  searchInput: { flex: 1, fontSize: 15, color: Colors.navy },
  rebbeCard: { flexDirection: "row", backgroundColor: Colors.white, borderRadius: 14, padding: 16, marginBottom: 10, gap: 14, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  rebbePhoto: { width: 64, height: 64, borderRadius: 32 },
  rebbePhotoPlaceholder: { width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center" },
  rebbeInitial: { color: Colors.gold, fontSize: 24, fontWeight: "bold" },
  rebbeInfo: { flex: 1 },
  rebbeName: { fontSize: 16, fontWeight: "600", color: Colors.navy },
  rebbeTitle: { fontSize: 13, color: Colors.navyOpacity70, marginTop: 2 },
  contactBtns: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  contactBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.goldOpacity15, borderRadius: 20 },
  contactBtnText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  sectionHeader: { backgroundColor: Colors.creamDark, paddingHorizontal: 16, paddingVertical: 6 },
  sectionHeaderText: { fontSize: 13, fontWeight: "700", color: Colors.navyOpacity50, letterSpacing: 0.5 },
  alumniCard: { backgroundColor: Colors.white, borderRadius: 12, marginBottom: 6, overflow: "hidden", shadowColor: Colors.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  alumniRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  alumniAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.navyOpacity10, alignItems: "center", justifyContent: "center" },
  alumniAvatarText: { fontSize: 16, fontWeight: "600", color: Colors.navy },
  alumniInfo: { flex: 1 },
  alumniName: { fontSize: 15, fontWeight: "500", color: Colors.navy },
  alumniLocation: { fontSize: 12, color: Colors.navyOpacity50, marginTop: 2 },
  alumniExpanded: { paddingHorizontal: 14, paddingBottom: 14 },
  empty: { alignItems: "center", padding: 40, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.navyOpacity50 },
  loadMoreFooter: { flexDirection: "row", alignItems: "center", justifyContent: "center", padding: 16, gap: 8 },
  loadMoreText: { fontSize: 13, color: Colors.navyOpacity70 },
});
