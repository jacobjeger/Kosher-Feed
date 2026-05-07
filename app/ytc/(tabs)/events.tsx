// YTC: events list. Verbatim port from
// /tmp/ytc-source/expo-app/app/(tabs)/events.tsx with imports remapped.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, Platform, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchEvents } from "@/lib/ytc/firebase";
import type { YtcEvent } from "@/types/ytc";

export default function EventsScreen() {
  const [events, setEvents] = useState<YtcEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadEvents = async () => {
    try {
      const data = await fetchEvents();
      setEvents(data as YtcEvent[]);
    } catch (e) {
      console.error("YTC Events load error:", e);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadEvents(); }, []);
  const onRefresh = useCallback(() => { setRefreshing(true); loadEvents(); }, []);

  const today = new Date().toISOString().split("T")[0];
  const upcoming = useMemo(() => events.filter((e) => e.date >= today), [events, today]);
  const past = useMemo(() => events.filter((e) => e.date < today).reverse(), [events, today]);

  const renderEvent = (event: YtcEvent, isPast: boolean) => {
    const d = new Date(event.date + "T00:00:00");
    const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const day = String(d.getDate());
    return (
      <View key={event.id} style={[styles.eventCard, isPast && styles.eventCardPast]}>
        <View style={[styles.dateBadge, isPast && styles.dateBadgePast]}>
          <Text style={[styles.dateMonth, isPast && styles.dateMonthPast]}>{month}</Text>
          <Text style={[styles.dateDay, isPast && styles.dateDayPast]}>{day}</Text>
        </View>
        <View style={styles.eventBody}>
          <Text style={[styles.eventName, isPast && styles.textMuted]}>{event.eventName}</Text>
          <Text style={[styles.eventFamily, isPast && styles.textMuted]}>{event.personFamily}</Text>
          <View style={styles.eventMeta}>
            <Text style={styles.metaText}>📍 {event.location}</Text>
            {event.time && <Text style={styles.metaText}>🕐 {event.time}</Text>}
          </View>
          {event.type && <View style={styles.typeBadge}><Text style={styles.typeBadgeText}>{event.type}</Text></View>}
          {event.description && <Text style={[styles.eventDesc, isPast && styles.textMuted]}>{event.description}</Text>}
        </View>
      </View>
    );
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}><Text style={styles.headerTitle}>Yeshiva Simchos</Text></View>
        <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <FlatList
        data={[]}
        keyExtractor={() => ""}
        renderItem={null}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.navy} />}
        ListHeaderComponent={
          <>
            <View style={styles.header}><Text style={styles.headerTitle}>Yeshiva Simchos</Text></View>
            <View style={styles.body}>
              {upcoming.length > 0 ? (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Upcoming</Text>
                  {upcoming.map((e) => renderEvent(e, false))}
                </View>
              ) : (
                <View style={styles.emptySection}>
                  <Text style={styles.emptyIcon}>📅</Text>
                  <Text style={styles.emptyText}>No upcoming simchos</Text>
                </View>
              )}
              {past.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Past Simchos</Text>
                  {past.map((e) => renderEvent(e, true))}
                </View>
              )}
            </View>
          </>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  header: { backgroundColor: Colors.navy, paddingVertical: 28, alignItems: "center" },
  headerTitle: { color: Colors.cream, fontSize: 24, fontWeight: "bold", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  body: { padding: 16, gap: 24, paddingBottom: 120 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: Colors.navy, fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  emptySection: { alignItems: "center", paddingVertical: 40, gap: 12 },
  emptyIcon: { fontSize: 40 },
  emptyText: { fontSize: 15, color: Colors.navyOpacity50 },
  eventCard: { flexDirection: "row", backgroundColor: Colors.white, borderRadius: 14, padding: 16, gap: 14, shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 2 },
  eventCardPast: { opacity: 0.65 },
  dateBadge: { width: 54, height: 54, borderRadius: 10, backgroundColor: Colors.navy, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dateBadgePast: { backgroundColor: Colors.navyOpacity50 },
  dateMonth: { color: Colors.gold, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  dateMonthPast: { color: Colors.creamOpacity70 },
  dateDay: { color: Colors.cream, fontSize: 22, fontWeight: "bold", lineHeight: 26 },
  dateDayPast: { color: Colors.cream },
  eventBody: { flex: 1, gap: 4 },
  eventName: { fontSize: 16, fontWeight: "600", color: Colors.navy },
  eventFamily: { fontSize: 14, color: Colors.navyOpacity70, fontWeight: "500" },
  eventMeta: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
  metaText: { fontSize: 12, color: Colors.navyOpacity50 },
  typeBadge: { alignSelf: "flex-start", backgroundColor: Colors.goldOpacity15, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, marginTop: 4 },
  typeBadgeText: { fontSize: 11, color: Colors.navy, fontWeight: "500" },
  eventDesc: { fontSize: 13, color: Colors.navyOpacity70, lineHeight: 19, marginTop: 4 },
  textMuted: { color: Colors.navyOpacity50 },
});
