// YTC: alumni contact submission/edit modal. Mirrors the website's
// app/contacts/contacts-content.tsx flow.
//
// On open: if the user already has a submission (keyed by email),
// pre-fill the form fields. Submit re-uses the same doc id, so this
// component handles both first-time joins and edits.

import React, { useEffect, useState } from "react";
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { fetchMyAlumniContact, submitAlumniContact } from "@/lib/ytc/firebase";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  submitterEmail: string;
  submitterDisplayName?: string | null;
}

export function SubmitAlumniContactModal({ visible, onClose, onSubmitted, submitterEmail, submitterDisplayName }: Props) {
  const [name, setName] = useState(submitterDisplayName ?? "");
  const [email, setEmail] = useState(submitterEmail);
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isEdit, setIsEdit] = useState(false);
  const [status, setStatus] = useState<"pending" | "approved" | "rejected" | null>(null);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    fetchMyAlumniContact(submitterEmail.toLowerCase())
      .then((existing) => {
        if (existing) {
          setName(existing.name || submitterDisplayName || "");
          setEmail(existing.email ?? submitterEmail);
          setPhone(existing.phone ?? "");
          setLocation(existing.location ?? "");
          setStatus(existing.status);
          setIsEdit(true);
        } else {
          setName(submitterDisplayName ?? "");
          setEmail(submitterEmail);
          setPhone(""); setLocation("");
          setStatus(null);
          setIsEdit(false);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [visible, submitterEmail, submitterDisplayName]);

  const submit = async () => {
    if (!name.trim() || !location.trim()) {
      Alert.alert("Missing fields", "Please fill in Name and Location.");
      return;
    }
    setSubmitting(true);
    try {
      await submitAlumniContact({
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        location: location.trim(),
        submittedBy: submitterEmail,
      });
      Alert.alert(
        isEdit ? "Updated" : "Submitted",
        isEdit
          ? "Your directory entry has been updated."
          : "Your entry has been submitted and will appear once approved by an admin.",
        [{ text: "OK", onPress: () => { onSubmitted?.(); onClose(); } }],
      );
    } catch (e: any) {
      Alert.alert("Submission failed", e?.message ?? "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={22} color={Colors.cream} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isEdit ? "Edit Your Info" : "Join the Directory"}</Text>
          <View style={{ width: 22 }} />
        </View>

        {loading ? (
          <View style={styles.loader}><ActivityIndicator size="large" color={Colors.navy} /></View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
            {status && (
              <View style={[styles.statusPill, status === "approved" ? styles.statusApproved : status === "rejected" ? styles.statusRejected : styles.statusPending]}>
                <Text style={styles.statusText}>
                  {status === "approved" ? "Approved · publicly visible" : status === "rejected" ? "Rejected — contact alumni@ytchaim.com" : "Pending admin review"}
                </Text>
              </View>
            )}

            <View>
              <Text style={styles.label}>Name <Text style={styles.req}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={name} onChangeText={setName}
                autoCapitalize="words"
                placeholder="Your name as it should appear"
                placeholderTextColor={Colors.navyOpacity50}
              />
            </View>

            <View>
              <Text style={styles.label}>Location <Text style={styles.req}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={location} onChangeText={setLocation}
                placeholder="e.g. Lakewood, NJ"
                placeholderTextColor={Colors.navyOpacity50}
              />
            </View>

            <View>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email} onChangeText={setEmail}
                keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
                placeholder="Optional contact email"
                placeholderTextColor={Colors.navyOpacity50}
              />
            </View>

            <View>
              <Text style={styles.label}>Phone</Text>
              <TextInput
                style={styles.input}
                value={phone} onChangeText={setPhone}
                keyboardType="phone-pad"
                placeholder="Optional"
                placeholderTextColor={Colors.navyOpacity50}
              />
            </View>

            <Text style={styles.disclaimer}>
              By submitting, you allow your name + location (plus contact info if you provided it) to be visible to other approved alumni in the YTC directory.
            </Text>

            <TouchableOpacity style={[styles.submitBtn, submitting && styles.submitBtnDisabled]} onPress={submit} disabled={submitting}>
              {submitting
                ? <ActivityIndicator color={Colors.cream} />
                : <Text style={styles.submitBtnText}>{isEdit ? "Save changes" : "Submit"}</Text>}
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: Colors.navy, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
  },
  headerTitle: { color: Colors.cream, fontSize: 16, fontWeight: "600", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  loader: { flex: 1, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 13, fontWeight: "600", color: Colors.navy, marginBottom: 6 },
  req: { color: Colors.error },
  input: {
    backgroundColor: Colors.white, borderRadius: 10, borderWidth: 1, borderColor: Colors.goldOpacity30,
    padding: 12, fontSize: 14, color: Colors.navy,
  },
  statusPill: { padding: 10, borderRadius: 10 },
  statusApproved: { backgroundColor: Colors.goldOpacity15 },
  statusPending: { backgroundColor: Colors.navyOpacity10 },
  statusRejected: { backgroundColor: "rgba(220, 38, 38, 0.1)" },
  statusText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  disclaimer: { fontSize: 11, color: Colors.navyOpacity70, lineHeight: 16 },
  submitBtn: { backgroundColor: Colors.navy, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 8 },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: Colors.cream, fontSize: 15, fontWeight: "600" },
});
