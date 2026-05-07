// YTC: simcha submission modal. Mirrors the website's
// app/events/events-content.tsx submission flow:
//   1. Pick image (optional) via expo-image-picker
//   2. Upload to Firebase Storage simcha-images/{ts}-{filename}
//   3. Write to simchaSubmissions with status: "new"
//   Admin then reviews + creates the public events doc.
//
// We do NOT write directly to events — that's a moderation bypass
// and the website explicitly routes user submissions through review.

import React, { useState } from "react";
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Platform, Image,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { submitSimcha, uploadSimchaImage } from "@/lib/ytc/firebase";

const SIMCHA_TYPES = [
  "Bar Mitzvah", "Wedding", "Engagement", "Birth", "Bris", "Pidyon Haben",
  "Anniversary", "Other",
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  submitterEmail: string;
}

export function SubmitSimchaModal({ visible, onClose, onSubmitted, submitterEmail }: Props) {
  const [fullName, setFullName] = useState("");
  const [simchaType, setSimchaType] = useState(SIMCHA_TYPES[0]);
  const [date, setDate] = useState(""); // YYYY-MM-DD, free-text for v1
  const [connection, setConnection] = useState("");
  const [message, setMessage] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setFullName(""); setSimchaType(SIMCHA_TYPES[0]); setDate("");
    setConnection(""); setMessage(""); setImageUri(null); setImageName(null);
  };

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photos access denied", "Enable Photos access in Settings to add an image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setImageUri(asset.uri);
      setImageName(asset.fileName ?? `simcha-${Date.now()}.jpg`);
    }
  };

  const submit = async () => {
    if (!fullName.trim() || !simchaType.trim() || !date.trim()) {
      Alert.alert("Missing fields", "Please fill in Name, Type, and Date.");
      return;
    }
    setSubmitting(true);
    try {
      let imageUrl: string | null = null;
      if (imageUri && imageName) {
        imageUrl = await uploadSimchaImage(imageUri, imageName);
      }
      await submitSimcha({
        fullName: fullName.trim(),
        simchaType,
        date: date.trim(),
        connection: connection.trim(),
        message: message.trim(),
        imageUrl,
        submittedBy: submitterEmail,
      });
      Alert.alert(
        "Submitted",
        "Thank you! Your simcha is awaiting admin approval. You'll see it on the public list once reviewed.",
        [{ text: "OK", onPress: () => { reset(); onSubmitted?.(); onClose(); } }],
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
          <Text style={styles.headerTitle}>Submit a Simcha</Text>
          <View style={{ width: 22 }} />
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 100, gap: 16 }} keyboardShouldPersistTaps="handled">
          <View style={styles.note}>
            <Text style={styles.noteText}>Submissions are reviewed by an admin before appearing on the public simchos list.</Text>
          </View>

          <View>
            <Text style={styles.label}>Name <Text style={styles.req}>*</Text></Text>
            <TextInput
              style={styles.input}
              value={fullName} onChangeText={setFullName}
              placeholder="e.g. Cohen Family"
              placeholderTextColor={Colors.navyOpacity50}
            />
          </View>

          <View>
            <Text style={styles.label}>Type of Simcha <Text style={styles.req}>*</Text></Text>
            <View style={styles.chipRow}>
              {SIMCHA_TYPES.map((t) => (
                <TouchableOpacity key={t} style={[styles.chip, simchaType === t && styles.chipActive]} onPress={() => setSimchaType(t)}>
                  <Text style={[styles.chipText, simchaType === t && styles.chipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View>
            <Text style={styles.label}>Date <Text style={styles.req}>*</Text></Text>
            <TextInput
              style={styles.input}
              value={date} onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={Colors.navyOpacity50}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View>
            <Text style={styles.label}>Your Connection</Text>
            <TextInput
              style={styles.input}
              value={connection} onChangeText={setConnection}
              placeholder="e.g. Father, Brother, Friend"
              placeholderTextColor={Colors.navyOpacity50}
            />
          </View>

          <View>
            <Text style={styles.label}>Message</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={message} onChangeText={setMessage}
              placeholder="Anything else you'd like to share"
              placeholderTextColor={Colors.navyOpacity50}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          <View>
            <Text style={styles.label}>Photo (optional)</Text>
            {imageUri ? (
              <View style={styles.imagePreview}>
                <Image source={{ uri: imageUri }} style={styles.imagePreviewImg} />
                <TouchableOpacity onPress={() => { setImageUri(null); setImageName(null); }} style={styles.removeImageBtn}>
                  <Ionicons name="close-circle" size={28} color={Colors.error} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.pickImageBtn} onPress={pickImage}>
                <Ionicons name="image-outline" size={22} color={Colors.navy} />
                <Text style={styles.pickImageText}>Choose photo</Text>
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity style={[styles.submitBtn, submitting && styles.submitBtnDisabled]} onPress={submit} disabled={submitting}>
            {submitting ? <ActivityIndicator color={Colors.cream} /> : <Text style={styles.submitBtnText}>Submit for review</Text>}
          </TouchableOpacity>
        </ScrollView>
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
  note: { backgroundColor: Colors.goldOpacity15, padding: 12, borderRadius: 10 },
  noteText: { fontSize: 12, color: Colors.navy, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: "600", color: Colors.navy, marginBottom: 6 },
  req: { color: Colors.error },
  input: {
    backgroundColor: Colors.white, borderRadius: 10, borderWidth: 1, borderColor: Colors.goldOpacity30,
    padding: 12, fontSize: 14, color: Colors.navy,
  },
  textarea: { minHeight: 80 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.creamDark },
  chipActive: { backgroundColor: Colors.navy },
  chipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  chipTextActive: { color: Colors.cream },
  pickImageBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.goldOpacity30,
    borderRadius: 10, padding: 14, justifyContent: "center",
  },
  pickImageText: { fontSize: 14, color: Colors.navy, fontWeight: "500" },
  imagePreview: { position: "relative" },
  imagePreviewImg: { width: "100%", height: 200, borderRadius: 12, backgroundColor: Colors.creamDark },
  removeImageBtn: { position: "absolute", top: 6, right: 6, backgroundColor: Colors.cream, borderRadius: 14 },
  submitBtn: { backgroundColor: Colors.navy, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 8 },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: Colors.cream, fontSize: 15, fontWeight: "600" },
});
