import React, { useState, useEffect, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Platform, Alert, ActivityIndicator, TextInput, Modal, KeyboardAvoidingView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { apiRequest } from "@/lib/query-client";
import { lightHaptic, mediumHaptic } from "@/lib/haptics";
import { getLogsSnapshot } from "@/lib/error-logger";
import { safeGoBack } from "@/lib/safe-back";
import { useBackHandler } from "@/hooks/useBackHandler";
import FocusableView from "@/components/FocusableView";

interface RowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onPress: () => void;
}

function Row({ icon, label, value, onPress }: RowProps) {
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  return (
    <FocusableView
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceAlt : colors.surface },
      ]}
      onPress={onPress}
    >
      <View style={styles.rowLeft}>
        <View style={[styles.iconBg, { backgroundColor: colors.accentLight }]}>
          {icon}
        </View>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      </View>
      {value ? (
        <Text style={[styles.rowValue, { color: colors.textSecondary }]}>{value}</Text>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
      )}
    </FocusableView>
  );
}

export default function FeedbackScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;

  const [deviceId, setDeviceId] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [feedbackType, setFeedbackType] = useState<"shiur_request" | "technical_issue">("shiur_request");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  useBackHandler(useCallback(() => {
    if (showModal) { setShowModal(false); return true; }
    safeGoBack(); return true;
  }, [showModal]));

  const openType = (type: "shiur_request" | "technical_issue") => {
    lightHaptic();
    setFeedbackType(type);
    setSubject("");
    setMessage("");
    setContact("");
    setShowModal(true);
  };

  const handleSubmit = async () => {
    if (!subject.trim() || !message.trim()) {
      Alert.alert("Missing Info", "Please fill in both the subject and details.");
      return;
    }
    setSending(true);
    try {
      let deviceLogs: string | null = null;
      if (feedbackType === "technical_issue") {
        try {
          const logs = getLogsSnapshot();
          if (logs.length > 0) deviceLogs = JSON.stringify(logs.slice(0, 100));
        } catch {}
      }
      await apiRequest("POST", "/api/feedback", {
        deviceId,
        type: feedbackType,
        subject: subject.trim(),
        message: message.trim(),
        contactInfo: contact.trim() || null,
        deviceLogs,
      });
      mediumHaptic();
      setShowModal(false);
      setSubject("");
      setMessage("");
      setContact("");
      Alert.alert("Thank You", feedbackType === "shiur_request"
        ? "Your shiur request has been submitted. We'll review it soon!"
        : "Your report has been submitted. We'll look into it!");
    } catch {
      Alert.alert("Error", "Failed to send feedback. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.cardBorder }]}>
        <FocusableView onPress={() => safeGoBack()} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </FocusableView>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Feedback & Messages</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={[styles.section, { borderColor: colors.cardBorder, backgroundColor: colors.surface }]}>
          <Row
            icon={<Ionicons name="musical-notes" size={20} color={colors.accent} />}
            label="Request a Shiur"
            onPress={() => openType("shiur_request")}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Row
            icon={<Ionicons name="construct" size={20} color="#f59e0b" />}
            label="Report a Problem"
            onPress={() => openType("technical_issue")}
          />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Row
            icon={<Ionicons name="chatbubbles" size={20} color={colors.accent} />}
            label="Messages"
            value="View"
            onPress={() => { lightHaptic(); router.push("/messages"); }}
          />
        </View>

        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Request new shiurim, report issues, or view messages from the ShiurPod team.
        </Text>
      </ScrollView>

      <Modal
        visible={showModal}
        animationType="slide"
        onRequestClose={() => setShowModal(false)}
        presentationStyle="fullScreen"
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[modalStyles.modal, { backgroundColor: colors.surface, paddingTop: insets.top + 12 }]}
        >
          <View style={{ flex: 1 }} accessibilityViewIsModal={true}>
            <View style={modalStyles.modalHeader}>
              <Text style={[modalStyles.modalTitle, { color: colors.text }]}>
                {feedbackType === "shiur_request" ? "Request a Shiur" : "Report a Problem"}
              </Text>
              <FocusableView onPress={() => setShowModal(false)} hitSlop={8}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </FocusableView>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" bounces={false}>
              <Text style={[modalStyles.label, { color: colors.textSecondary, marginTop: 0 }]}>
                {feedbackType === "shiur_request" ? "Shiur / Speaker Name" : "What went wrong?"}
              </Text>
              <TextInput
                style={[modalStyles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                placeholder={feedbackType === "shiur_request" ? "e.g. Rabbi Ploni - Gemara Shiur" : "e.g. Audio stops playing"}
                placeholderTextColor={colors.textSecondary}
                value={subject}
                onChangeText={setSubject}
                maxLength={200}
              />

              <Text style={[modalStyles.label, { color: colors.textSecondary }]}>Details</Text>
              <TextInput
                style={[modalStyles.input, modalStyles.textArea, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                placeholder={feedbackType === "shiur_request"
                  ? "Any details about where to find this shiur, RSS feed link, etc."
                  : "Please describe the issue in detail. What were you doing when it happened?"}
                placeholderTextColor={colors.textSecondary}
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
                maxLength={5000}
              />

              <Text style={[modalStyles.label, { color: colors.textSecondary }]}>Contact Info (optional)</Text>
              <TextInput
                style={[modalStyles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                placeholder="Email or phone (optional — we'll reply in Messages)"
                placeholderTextColor={colors.textSecondary}
                value={contact}
                onChangeText={setContact}
                maxLength={200}
                autoCapitalize="none"
              />

              <FocusableView
                style={[modalStyles.submitBtn, { backgroundColor: colors.accent, opacity: sending ? 0.6 : 1 }]}
                onPress={handleSubmit}
                disabled={sending}
                focusRadius={12}
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={modalStyles.submitBtnText}>Submit</Text>
                )}
              </FocusableView>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 17, fontWeight: "700" },
  section: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBg: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  rowLabel: { fontSize: 15, fontWeight: "500" },
  rowValue: { fontSize: 13 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 58 },
  hint: { fontSize: 12, marginHorizontal: 24, marginTop: 12, lineHeight: 17 },
});

const modalStyles = StyleSheet.create({
  modal: { flex: 1, padding: 20, paddingBottom: Platform.OS === "web" ? 34 : 40 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  label: { fontSize: 13, fontWeight: "600", marginBottom: 6, marginTop: 12 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
  textArea: { minHeight: 80 },
  submitBtn: { marginTop: 20, borderRadius: 12, padding: 14, alignItems: "center" },
  submitBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
