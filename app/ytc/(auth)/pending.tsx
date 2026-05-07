// YTC: pending-approval screen. Verbatim port from
// /tmp/ytc-source/expo-app/app/(auth)/pending.tsx with imports remapped.
import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { useYtcAuth } from "@/contexts/YtcAuthContext";

export default function PendingScreen() {
  const { signOut, refreshStatus } = useYtcAuth();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refreshStatus();
    setIsRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.spacer} />
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
        <View style={styles.spacer} />
        <TouchableOpacity style={[styles.primaryBtn, isRefreshing && styles.btnDisabled]} onPress={handleRefresh} disabled={isRefreshing}>
          {isRefreshing ? <ActivityIndicator color={Colors.cream} /> : <Text style={styles.primaryBtnText}>Check Status</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={signOut} style={styles.signOutBtn}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  container: { flex: 1, alignItems: "center", paddingHorizontal: 24, paddingBottom: 40 },
  spacer: { flex: 1 },
  iconCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: Colors.goldOpacity15, alignItems: "center", justifyContent: "center", marginBottom: 24 },
  iconText: { fontSize: 48 },
  title: { fontSize: 28, fontWeight: "bold", color: Colors.navy, marginBottom: 12 },
  subtitle: { fontSize: 15, color: Colors.navyOpacity70, textAlign: "center", lineHeight: 22, paddingHorizontal: 16, marginBottom: 24 },
  infoBox: { backgroundColor: Colors.navyOpacity05, borderRadius: 16, padding: 20, width: "100%", gap: 12 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  infoIcon: { fontSize: 20 },
  infoText: { flex: 1, fontSize: 14, color: Colors.navyOpacity70, lineHeight: 20 },
  primaryBtn: { backgroundColor: Colors.navy, borderRadius: 12, paddingVertical: 16, alignItems: "center", width: "100%", marginBottom: 16 },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: Colors.cream, fontSize: 16, fontWeight: "600" },
  signOutBtn: { paddingVertical: 8 },
  signOutText: { fontSize: 14, fontWeight: "500", color: Colors.navyOpacity70 },
});
