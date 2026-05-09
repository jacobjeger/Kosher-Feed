// YTC: pending-approval screen. Verbatim port from
// /tmp/ytc-source/expo-app/app/(auth)/pending.tsx with imports remapped.
//
// Layout: a ScrollView wrapper so the Check-Status + Sign-Out buttons
// are always reachable even on small-display phones — the previous
// version used flex-1 spacers which clipped the buttons below the fold
// on Android phones with shorter viewports (the user reported the
// "refresh status" button was unreachable). The visible content is
// still vertically centered when there's room (minHeight + justify).
import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Dimensions, Platform } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { useYtcAuth } from "@/contexts/YtcAuthContext";

const { height: SCREEN_H } = Dimensions.get("window");

export default function PendingScreen() {
  const insets = useSafeAreaInsets();
  const { signOut, refreshStatus } = useYtcAuth();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshStatus();
    setIsRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView
        style={{ flex: 1 }}
        // contentContainerStyle uses minHeight so on tall screens the
        // content centers vertically; on short screens the button row
        // pushes the layout taller and ScrollView scrolls naturally.
        contentContainerStyle={[
          styles.scrollContent,
          // Top padding accounts for the floating close-X (rendered by
          // app/ytc/_layout.tsx at insets.top + 8) so the icon circle
          // doesn't tuck under it on edge-to-edge devices.
          { paddingTop: Math.max(insets.top + 56, 80), minHeight: SCREEN_H - insets.top - insets.bottom },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* YTC logo + brand block above the access-pending status,
             so the user lands on familiar branding instead of just an
             hourglass emoji on cream. Mirrors the loading-screen
             treatment in app/ytc/_layout.tsx. */}
        <Image
          source={require("@/assets/images/ytc-logo.png")}
          style={styles.logo}
          contentFit="contain"
        />
        <Text style={styles.brandTitle}>Yeshiva Toras Chaim</Text>
        <View style={styles.brandAccent} />
        <Text style={styles.brandSubtitle}>ALUMNI NETWORK</Text>
        <View style={styles.iconCircle}><Text style={styles.iconText}>⏳</Text></View>
        <Text style={styles.title}>Access Pending</Text>
        <Text style={styles.subtitle}>
          Your account has been created and is awaiting approval from an administrator.
        </Text>
        <View style={styles.infoBox}>
          <View style={styles.infoRow}>
            <Text style={styles.infoIcon}>✉️</Text>
            <Text style={styles.infoText}>You will receive an email once your account is approved</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoIcon}>❓</Text>
            <Text style={styles.infoText}>Questions? Contact alumni@ytchaim.com</Text>
          </View>
        </View>

        {/* Buttons — pushed to the bottom of the scroll content with a
             flexible spacer above so they sit at the bottom on tall
             screens AND remain reachable on short ones. */}
        <View style={styles.flexSpacer} />
        <TouchableOpacity style={[styles.primaryBtn, isRefreshing && styles.btnDisabled]} onPress={handleRefresh} disabled={isRefreshing}>
          {isRefreshing ? <ActivityIndicator color={Colors.cream} /> : <Text style={styles.primaryBtnText}>Check Status</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={signOut} style={styles.signOutBtn}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  scrollContent: {
    alignItems: "center",
    paddingHorizontal: 24,
    paddingBottom: 32,
  },
  flexSpacer: { flex: 1, minHeight: 24 },
  // Brand block — logo + serif title + gold rule + uppercase caption.
  logo: { width: 90, height: 90, marginBottom: 8 },
  brandTitle: {
    color: Colors.navy, fontSize: 22, fontWeight: "700", textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  brandAccent: { width: 60, height: 2, backgroundColor: Colors.gold, marginVertical: 8, opacity: 0.85 },
  brandSubtitle: {
    color: Colors.gold, fontSize: 11, fontWeight: "700", letterSpacing: 3.5,
    textAlign: "center", marginBottom: 20,
  },
  iconCircle: { width: 90, height: 90, borderRadius: 45, backgroundColor: Colors.goldOpacity15, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  iconText: { fontSize: 36 },
  title: { fontSize: 26, fontWeight: "bold", color: Colors.navy, marginBottom: 10 },
  subtitle: { fontSize: 15, color: Colors.navyOpacity70, textAlign: "center", lineHeight: 22, paddingHorizontal: 16, marginBottom: 22 },
  infoBox: { backgroundColor: Colors.navyOpacity05, borderRadius: 16, padding: 18, width: "100%", gap: 12 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  infoIcon: { fontSize: 20 },
  infoText: { flex: 1, fontSize: 14, color: Colors.navyOpacity70, lineHeight: 20 },
  primaryBtn: { backgroundColor: Colors.navy, borderRadius: 12, paddingVertical: 16, alignItems: "center", width: "100%", marginBottom: 12 },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: Colors.cream, fontSize: 16, fontWeight: "600" },
  signOutBtn: { paddingVertical: 8 },
  signOutText: { fontSize: 14, fontWeight: "500", color: Colors.navyOpacity70 },
});
