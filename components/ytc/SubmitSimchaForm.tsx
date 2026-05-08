// YTC: inline simcha submission form. Renders directly inside the
// events page below the past-events grid — matches the website's
// "Share Your Simcha" section that lives in the same scroll view as
// the upcoming + past lists.
//
// Submission flow mirrors lib/auth-context.tsx → lib/firebase
// helpers exactly: writes to simchaSubmissions with status "new"
// (admin reviews + creates the public events doc), uploads any
// attached image to Firebase Storage simcha-images/{ts}-{filename}.

import React, { useMemo, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, Platform, Image, Modal, Pressable,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { submitSimcha, uploadSimchaImage } from "@/lib/ytc/firebase";

interface Props {
  submitterEmail: string;
  onSubmitted?: () => void;
}

// YYYY-MM-DD format used by the events backend. Helpers keep the
// inline calendar's date math local to this file.
function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }
function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatDisplayDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function SubmitSimchaForm({ submitterEmail, onSubmitted }: Props) {
  const [fullName, setFullName] = useState("");
  // Type-of-simcha: free-text now (per user feedback). The previous
  // 8-chip menu didn't cover edge cases (sheva brachos, vort, hachnasas
  // sefer torah, etc) and forced people into "Other".
  const [simchaType, setSimchaType] = useState("");
  const [date, setDate] = useState("");
  const [connection, setConnection] = useState("");
  const [message, setMessage] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Inline calendar modal state — kept local since this is the only
  // form using a date picker.
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  const reset = () => {
    setFullName(""); setSimchaType(""); setDate("");
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
          <TextInput
            style={styles.input}
            value={simchaType} onChangeText={setSimchaType}
            placeholder="e.g. Bar Mitzvah, Wedding, Sheva Brachos"
            placeholderTextColor={Colors.navyOpacity50}
          />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.col}>
          <Text style={styles.label}>Date <Text style={styles.req}>*</Text></Text>
          {/* Tap-to-open calendar — replaces the YYYY-MM-DD typed text
               input. Stores the raw ISO string for the backend; shows
               a friendly "Sun, Jan 12, 2026" label to the user. */}
          <TouchableOpacity style={styles.dateBtn} onPress={() => setDatePickerOpen(true)} activeOpacity={0.7}>
            <Ionicons name="calendar-outline" size={16} color={Colors.navy} />
            <Text style={[styles.dateBtnText, !date && styles.dateBtnPlaceholder]}>
              {date ? formatDisplayDate(date) : "Pick a date"}
            </Text>
          </TouchableOpacity>
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

      {/* Lightweight inline calendar — pure JS so it stays OTA-able
           (no native @react-native-community/datetimepicker dep). */}
      <InlineDatePicker
        visible={datePickerOpen}
        valueIso={date}
        onClose={() => setDatePickerOpen(false)}
        onPick={(iso) => { setDate(iso); setDatePickerOpen(false); }}
      />
    </View>
  );
}

// ── Inline calendar ─────────────────────────────────────────────────
//
// Renders a month grid with prev/next-month nav. Today is bordered;
// the picked day is filled gold. We render it inside a Modal so it
// floats above the form without affecting the layout flow.

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function InlineDatePicker({ visible, valueIso, onClose, onPick }: {
  visible: boolean;
  valueIso: string;
  onClose: () => void;
  onPick: (iso: string) => void;
}) {
  const initial = useMemo(() => {
    if (valueIso) {
      const d = new Date(valueIso + "T00:00:00");
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }, [valueIso]);

  const [viewDate, setViewDate] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1));

  const cells = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: Array<{ day: number | null; iso: string | null }> = [];
    for (let i = 0; i < firstDay; i++) out.push({ day: null, iso: null });
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ day: d, iso: toIsoDate(new Date(year, month, d)) });
    }
    return out;
  }, [viewDate]);

  const monthLabel = viewDate.toLocaleString("en-US", { month: "long", year: "numeric" });
  const todayIso = toIsoDate(new Date());

  const goPrev = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const goNext = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={dpStyles.backdrop} onPress={onClose}>
        <Pressable style={dpStyles.card} onPress={() => {}}>
          <View style={dpStyles.navRow}>
            <TouchableOpacity onPress={goPrev} hitSlop={8} style={dpStyles.navBtn}>
              <Ionicons name="chevron-back" size={20} color={Colors.navy} />
            </TouchableOpacity>
            <Text style={dpStyles.monthLabel}>{monthLabel}</Text>
            <TouchableOpacity onPress={goNext} hitSlop={8} style={dpStyles.navBtn}>
              <Ionicons name="chevron-forward" size={20} color={Colors.navy} />
            </TouchableOpacity>
          </View>
          <View style={dpStyles.weekRow}>
            {WEEKDAYS.map((w, i) => <Text key={i} style={dpStyles.weekday}>{w}</Text>)}
          </View>
          <View style={dpStyles.grid}>
            {cells.map((c, i) => {
              if (!c.iso) return <View key={i} style={dpStyles.cell} />;
              const isPicked = c.iso === valueIso;
              const isToday = c.iso === todayIso;
              return (
                <TouchableOpacity
                  key={i}
                  style={[
                    dpStyles.cell,
                    isToday && !isPicked && dpStyles.cellToday,
                    isPicked && dpStyles.cellPicked,
                  ]}
                  onPress={() => onPick(c.iso!)}
                >
                  <Text style={[
                    dpStyles.cellText,
                    isPicked && dpStyles.cellTextPicked,
                  ]}>{c.day}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={dpStyles.footer}>
            <TouchableOpacity style={dpStyles.todayBtn} onPress={() => onPick(todayIso)}>
              <Text style={dpStyles.todayBtnText}>Today</Text>
            </TouchableOpacity>
            <TouchableOpacity style={dpStyles.cancelBtn} onPress={onClose}>
              <Text style={dpStyles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const CELL_SIZE = 40;
const dpStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 340, backgroundColor: Colors.white, borderRadius: 14, padding: 16, gap: 10 },
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  navBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: Colors.cream },
  monthLabel: { fontSize: 16, fontWeight: "700", color: Colors.navy },
  weekRow: { flexDirection: "row" },
  weekday: { width: CELL_SIZE, textAlign: "center", fontSize: 11, fontWeight: "600", color: Colors.navyOpacity50, paddingVertical: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: CELL_SIZE, height: CELL_SIZE, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  cellToday: { borderWidth: 1, borderColor: Colors.gold },
  cellPicked: { backgroundColor: Colors.navy },
  cellText: { fontSize: 14, color: Colors.navy },
  cellTextPicked: { color: Colors.cream, fontWeight: "700" },
  footer: { flexDirection: "row", gap: 8, marginTop: 4 },
  todayBtn: { flex: 1, backgroundColor: Colors.gold, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  todayBtnText: { fontSize: 13, fontWeight: "700", color: Colors.navy },
  cancelBtn: { flex: 1, backgroundColor: Colors.cream, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  cancelBtnText: { fontSize: 13, fontWeight: "600", color: Colors.navy },
});

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
  dateBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.white, borderRadius: 8, borderWidth: 1, borderColor: Colors.creamDark,
    padding: 12,
  },
  dateBtnText: { fontSize: 14, color: Colors.navy, fontWeight: "500" },
  dateBtnPlaceholder: { color: Colors.navyOpacity50, fontWeight: "400" },
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
