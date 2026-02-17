import React, { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Platform, TextInput, Alert, ActivityIndicator, KeyboardAvoidingView } from "react-native";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { safeGoBack } from "@/lib/safe-back";
import Colors from "@/constants/colors";
import { getDeviceId } from "@/lib/device-id";
import { getApiUrl } from "@/lib/query-client";
import { lightHaptic } from "@/lib/haptics";

const EFFECTIVE_DATE = "February 17, 2026";

function SectionHeader({ title, icon, colors }: { title: string; icon: string; colors: any }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon as any} size={22} color={colors.accent} />
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
    </View>
  );
}

function LegalParagraph({ text, colors }: { text: string; colors: any }) {
  return <Text style={[styles.paragraph, { color: colors.textSecondary }]}>{text}</Text>;
}

function NumberedItem({ number, title, text, colors }: { number: string; title: string; text: string; colors: any }) {
  return (
    <View style={styles.numberedItem}>
      <Text style={[styles.numberedTitle, { color: colors.text }]}>{number}. {title}</Text>
      <Text style={[styles.numberedText, { color: colors.textSecondary }]}>{text}</Text>
    </View>
  );
}

export default function LegalScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useAppColorScheme();
  const isDark = colorScheme === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const [activeTab, setActiveTab] = useState<"privacy" | "terms" | "contact">("privacy");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [sending, setSending] = useState(false);

  const handleSendContact = async () => {
    if (!contactMessage.trim()) {
      Alert.alert("Message Required", "Please enter your message before sending.");
      return;
    }
    setSending(true);
    try {
      const deviceId = await getDeviceId();
      const baseUrl = getApiUrl();
      const res = await fetch(new URL("/api/feedback", baseUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          type: "technical_issue",
          subject: `Legal Inquiry from ${contactName || "Anonymous"}`,
          message: contactMessage.trim(),
          contactInfo: contactEmail || undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to send");
      lightHaptic();
      Alert.alert("Sent", "Your inquiry has been submitted. We'll respond within 48 business hours.");
      setContactName("");
      setContactEmail("");
      setContactMessage("");
    } catch {
      Alert.alert("Error", "Could not send your message. Please try again later.");
    } finally {
      setSending(false);
    }
  };

  const tabColor = (tab: string) => activeTab === tab ? colors.accent : colors.textSecondary;
  const tabBg = (tab: string) => activeTab === tab ? (isDark ? "rgba(59,130,246,0.15)" : "rgba(59,130,246,0.08)") : "transparent";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 12 : insets.top + 8 }]}>
        <Pressable onPress={() => safeGoBack()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Legal</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {(["privacy", "terms", "contact"] as const).map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tab, { backgroundColor: tabBg(tab), borderColor: activeTab === tab ? colors.accent : "transparent" }]}
            onPress={() => { lightHaptic(); setActiveTab(tab); }}
          >
            <Ionicons
              name={tab === "privacy" ? "shield-checkmark" : tab === "terms" ? "document-text" : "mail"}
              size={16}
              color={tabColor(tab)}
            />
            <Text style={[styles.tabText, { color: tabColor(tab), fontWeight: activeTab === tab ? "700" : "500" }]}>
              {tab === "privacy" ? "Privacy" : tab === "terms" ? "Terms" : "Contact"}
            </Text>
          </Pressable>
        ))}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
        keyboardVerticalOffset={90}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
          showsVerticalScrollIndicator={false}
        >
          {activeTab === "privacy" && (
            <>
              <View style={[styles.effectiveDate, { backgroundColor: isDark ? "rgba(59,130,246,0.1)" : "rgba(59,130,246,0.05)", borderColor: colors.border }]}>
                <Text style={[styles.effectiveDateText, { color: colors.textSecondary }]}>Effective Date: {EFFECTIVE_DATE}</Text>
              </View>

              <SectionHeader title="Privacy Policy" icon="shield-checkmark" colors={colors} />

              <NumberedItem
                number="1"
                title="Data Collection via Contact Form"
                text="When you use the in-app contact form, we collect your name, email address, and the content of your message. This data is used exclusively to provide support and resolve your inquiries. We do not sell or share this information with third-party marketers."
                colors={colors}
              />
              <NumberedItem
                number="2"
                title="App Activity & Syncing"
                text="To provide a seamless experience, ShiurPod may track your playback progress and favorites. This data is stored locally on your device or linked to your anonymous device identifier to allow you to resume shiurim across different sessions."
                colors={colors}
              />
              <NumberedItem
                number="3"
                title="Third-Party RSS Content"
                text="ShiurPod is a directory. Audio files are streamed directly from the original creators' RSS feeds. Your IP address may be visible to these external hosting providers (e.g., Podbean, SoundCloud) when you stream audio. We do not control their privacy practices."
                colors={colors}
              />
              <NumberedItem
                number="4"
                title="Data Deletion"
                text="You may request the deletion of your support history and playback data at any time via the in-app contact form."
                colors={colors}
              />
              <NumberedItem
                number="5"
                title="No User Accounts"
                text="ShiurPod does not require user accounts. Your device is identified by an anonymous device ID generated locally. No personal information is required to use the app."
                colors={colors}
              />
            </>
          )}

          {activeTab === "terms" && (
            <>
              <View style={[styles.effectiveDate, { backgroundColor: isDark ? "rgba(59,130,246,0.1)" : "rgba(59,130,246,0.05)", borderColor: colors.border }]}>
                <Text style={[styles.effectiveDateText, { color: colors.textSecondary }]}>Effective Date: {EFFECTIVE_DATE}</Text>
              </View>

              <SectionHeader title="Terms of Service" icon="document-text" colors={colors} />

              <NumberedItem
                number="1"
                title="Role of ShiurPod"
                text="ShiurPod is a technical platform that aggregates publicly available Torah RSS feeds. We are not a publisher and do not own the intellectual property of the shiurim found within the app."
                colors={colors}
              />
              <NumberedItem
                number="2"
                title="Content Disclaimer"
                text="All audio content is the property of the respective speakers and institutions. ShiurPod does not endorse, verify, or take responsibility for the accuracy or halachic rulings contained in the audio content."
                colors={colors}
              />
              <NumberedItem
                number="3"
                title="No Modification"
                text='We provide a direct "bridge" to the original source. We do not edit the audio, remove ads, or alter the content in any way.'
                colors={colors}
              />
              <NumberedItem
                number="4"
                title="Creator Requests"
                text="If you are a creator and wish to have your feed removed from ShiurPod, please use our in-app contact form. We honor all valid takedown requests within 48 business hours."
                colors={colors}
              />

              <View style={[styles.disclaimerBox, { backgroundColor: isDark ? "rgba(245,158,11,0.1)" : "rgba(245,158,11,0.06)", borderColor: isDark ? "rgba(245,158,11,0.3)" : "rgba(245,158,11,0.2)" }]}>
                <Ionicons name="information-circle" size={20} color="#f59e0b" style={{ marginRight: 10, marginTop: 2 }} />
                <Text style={[styles.disclaimerText, { color: colors.textSecondary }]}>
                  ShiurPod is a directory of third-party RSS feeds. All rights to the audio content and cover art belong to the original creators. ShiurPod is not affiliated with the speakers or organizations listed unless explicitly stated.
                </Text>
              </View>
            </>
          )}

          {activeTab === "contact" && (
            <>
              <SectionHeader title="Contact Us" icon="mail" colors={colors} />
              <LegalParagraph
                text="Have a legal inquiry, data deletion request, or a content takedown request? Fill out the form below and we'll respond within 48 business hours."
                colors={colors}
              />

              <View style={styles.formGroup}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Name (optional)</Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
                  placeholder="Your name"
                  placeholderTextColor={colors.textSecondary}
                  value={contactName}
                  onChangeText={setContactName}
                  autoCapitalize="words"
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Email (optional)</Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
                  placeholder="your@email.com"
                  placeholderTextColor={colors.textSecondary}
                  value={contactEmail}
                  onChangeText={setContactEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Message</Text>
                <TextInput
                  style={[styles.formInputMulti, { backgroundColor: colors.surface, color: colors.text, borderColor: colors.border }]}
                  placeholder="Describe your inquiry..."
                  placeholderTextColor={colors.textSecondary}
                  value={contactMessage}
                  onChangeText={setContactMessage}
                  multiline
                  numberOfLines={6}
                  textAlignVertical="top"
                />
              </View>

              <Pressable
                style={[styles.sendBtn, { backgroundColor: colors.accent, opacity: sending ? 0.6 : 1 }]}
                onPress={handleSendContact}
                disabled={sending}
              >
                {sending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="send" size={18} color="#fff" style={{ marginRight: 8 }} />
                    <Text style={styles.sendBtnText}>Send Inquiry</Text>
                  </>
                )}
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
  },
  tabText: { fontSize: 13 },
  scrollView: { flex: 1 },
  scrollContent: { padding: 20 },
  effectiveDate: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 20,
  },
  effectiveDateText: { fontSize: 13, fontWeight: "500" },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
    marginTop: 4,
  },
  sectionTitle: { fontSize: 20, fontWeight: "700" },
  paragraph: { fontSize: 15, lineHeight: 23, marginBottom: 16 },
  numberedItem: { marginBottom: 20 },
  numberedTitle: { fontSize: 15, fontWeight: "600", marginBottom: 6 },
  numberedText: { fontSize: 14, lineHeight: 22 },
  disclaimerBox: {
    flexDirection: "row",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
  },
  disclaimerText: { fontSize: 13, lineHeight: 20, flex: 1 },
  formGroup: { marginBottom: 18 },
  formLabel: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  formInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  formInputMulti: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 140,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
  },
  sendBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
