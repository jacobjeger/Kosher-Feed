// YTC: inline simcha submission form. Renders directly inside the
// events page below the past-events grid — matches the website's
// "Share Your Simcha" section that lives in the same scroll view as
// the upcoming + past lists.
//
// Submission flow mirrors lib/auth-context.tsx → lib/firebase
// helpers exactly: writes to simchaSubmissions with status "new"
// (admin reviews + creates the public events doc), uploads any
// attached image to Firebase Storage simcha-images/{ts}-{filename}.

import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, Platform, Image,
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
  submitterEmail: string;
  onSubmitted?: () => void;
}

export function SubmitSimchaForm({ submitterEmail, onSubmitted }: Props) {
  const [fullName, setFullName] = useState("");
  const [simchaType, setSimchaType] = useState(SIMCHA_TYPES[0]);
  const [date, setDate] = useState("");
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
        [{ text: "OK", onPress: () => { reset(); onSubmitted?.(); } }],
      );
    } catch (e: any) {
      Alert.alert("Submission failed", e?.message ?? "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <View style={styles.titleAccent} />
        <Text style={styles.title}>Share Your Simcha</Text>
        <View style={styles.titleAccent} />
      </View>
      <Text style={styles.subtitle}>
        Submissions are reviewed by an admin before appearing on the public simchos list.
      </Text>

      <View style={styles.row}>
        <View style={styles.col}>
          <Text style={styles.label}>Full Name <Text style={styles.req}>*</Text></Text>
          <TextInput
            style={styles.input}
            value={fullName} onChangeText={setFullName}
            placeholder="Enter full name"
            placeholderTextColor={Colors.navyOpacity50}
          />
        </View>
        <View style={styles.col}>
          <Text style={styles.label}>Type of Simcha <Text style={styles.req}>*</Text></Text>
          <View style={styles.chipRow}>
            {SIMCHA_TYPES.map((t) => (
              <TouchableOpacity key={t} style={[styles.chip, simchaType === t && styles.chipActive]} onPress={() => setSimchaType(t)}>
                <Text style={[styles.chipText, simchaType === t && styles.chipTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.col}>
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
        <View style={styles.col}>
          <Text style={styles.label}>Connection to Yeshiva</Text>
          <TextInput
            style={styles.input}
            value={connection} onChangeText={setConnection}
            placeholder="Alumnus, Parent, etc."
            placeholderTextColor={Colors.navyOpacity50}
          />
        </View>
      </View>

      <View>
        <Text style={styles.label}>Additional Details <Text style={styles.optionalLabel}>(Optional)</Text></Text>
        <TextInput
          style={[styles.input, styles.textarea]}
          value={message} onChangeText={setMessage}
          placeholder="Share any additional details about your simcha..."
          placeholderTextColor={Colors.navyOpacity50}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </View>

      <View>
        <Text style={styles.label}>Photo <Text style={styles.optionalLabel}>(Optional)</Text></Text>
        {imageUri ? (
          <View style={styles.imagePreview}>
            <Image source={{ uri: imageUri }} style={styles.imagePreviewImg} />
            <TouchableOpacity onPress={() => { setImageUri(null); setImageName(null); }} style={styles.removeImageBtn}>
              <Ionicons name="close-circle" size={28} color={Colors.error} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.pickImageBtn} onPress={pickImage}>
            <Ionicons name="image-outline" size={20} color={Colors.navy} />
            <Text style={styles.pickImageText}>Choose photo</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity style={[styles.submitBtn, submitting && styles.submitBtnDisabled]} onPress={submit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={Colors.cream} /> : <Text style={styles.submitBtnText}>Share Your Simcha</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.white,
    borderRadius: 14,
    padding: 20,
    gap: 14,
    borderWidth: 1, borderColor: Colors.goldOpacity30,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  titleRow: {
    flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4,
  },
  titleAccent: { flex: 1, height: 1, backgroundColor: Colors.goldOpacity30 },
  title: {
    fontSize: 20, fontWeight: "700", color: Colors.navy,
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  subtitle: { fontSize: 12, color: Colors.navyOpacity70, lineHeight: 18, marginBottom: 4 },
  row: { gap: 14 },
  col: {},
  label: { fontSize: 13, fontWeight: "600", color: Colors.navy, marginBottom: 6 },
  optionalLabel: { color: Colors.navyOpacity50, fontWeight: "400" },
  req: { color: Colors.error },
  input: {
    backgroundColor: Colors.white, borderRadius: 8, borderWidth: 1, borderColor: Colors.creamDark,
    padding: 12, fontSize: 14, color: Colors.navy,
  },
  textarea: { minHeight: 100 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: Colors.creamDark },
  chipActive: { backgroundColor: Colors.navy },
  chipText: { fontSize: 12, color: Colors.navy, fontWeight: "500" },
  chipTextActive: { color: Colors.cream },
  pickImageBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.creamDark,
    borderRadius: 8, padding: 14, justifyContent: "center",
  },
  pickImageText: { fontSize: 14, color: Colors.navy, fontWeight: "500" },
  imagePreview: { position: "relative" },
  imagePreviewImg: { width: "100%", height: 200, borderRadius: 8, backgroundColor: Colors.creamDark },
  removeImageBtn: { position: "absolute", top: 6, right: 6, backgroundColor: Colors.cream, borderRadius: 14 },
  submitBtn: {
    backgroundColor: Colors.navy, paddingVertical: 14, borderRadius: 8,
    alignItems: "center", marginTop: 4,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: Colors.cream, fontSize: 14, fontWeight: "600", letterSpacing: 0.3 },
});
