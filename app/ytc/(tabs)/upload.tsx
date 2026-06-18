// YTC: Upload Shiur tab. Mirrors the website's app/upload-shiur/page.tsx
// "single" tab — the bulk uploader is web-only for now.
//
// Visibility is controlled by app/ytc/(tabs)/_layout.tsx (href:null when
// !canUpload), but we also keep an in-screen guard so a real-time
// permission revocation while the user is mid-upload navigates them away
// instead of silently failing the Firestore write at submit time.
import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator,
  ScrollView, Modal, Pressable, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
// expo-document-picker is loaded LAZILY (inside the pick handler) because
// the native module isn't included in every APK build of ShiurPod — when
// it isn't, a top-level import resolves the module to `undefined`, and
// expo-router's route-loader trips on `.ErrorBoundary of undefined`,
// crashing the entire YTC tab navigator with a white screen. Lazy import
// + try/catch lets the route still mount and gives the upload action a
// clean user-facing message instead.
let _DocumentPicker: any | null = null;
function loadDocumentPicker(): any | null {
  if (_DocumentPicker) return _DocumentPicker;
  try { _DocumentPicker = require("expo-document-picker"); }
  catch { _DocumentPicker = null; }
  return _DocumentPicker;
}
import { useYtcAuth } from "@/contexts/YtcAuthContext";
import { useYtcColors } from "@/contexts/YtcThemeContext";
import { ytcColors as StaticColors } from "@/constants/ytcColors";
import { getShiurOptions, type ShiurOptions } from "@/lib/ytc/email-subscriptions";
import { uploadShiurFile, submitShiur } from "@/lib/ytc/shiur-upload";

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

interface PickedFile { uri: string; name: string; mime: string; size: number | null; }

export default function UploadShiurScreen() {
  const insets = useSafeAreaInsets();
  const Colors = useYtcColors();
  const { user, canUpload, isAdmin } = useYtcAuth();

  // Permission revoked mid-session → bounce back to the home tab.
  useEffect(() => {
    if (!canUpload) router.replace("/ytc/(tabs)" as any);
  }, [canUpload]);

  const [options, setOptions] = useState<ShiurOptions>({ rebbeim: [], tags: [], series: [] });
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [title, setTitle] = useState("");
  const [rebbe, setRebbe] = useState("");
  const [date, setDate] = useState("");
  const [uploaderName, setUploaderName] = useState(user?.displayName ?? "");
  const [description, setDescription] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [series, setSeries] = useState<string>(""); // empty == none

  const [audio, setAudio] = useState<PickedFile | null>(null);
  const [pdf, setPdf] = useState<PickedFile | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [progressPct, setProgressPct] = useState(0);

  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [rebbePickerOpen, setRebbePickerOpen] = useState(false);
  const [seriesPickerOpen, setSeriesPickerOpen] = useState(false);

  const reset = () => {
    setTitle(""); setRebbe(""); setDate("");
    setUploaderName(user?.displayName ?? "");
    setDescription("");
    setSelectedTags(new Set());
    setSeries("");
    setAudio(null); setPdf(null);
    setProgressPct(0); setProgressLabel("");
  };

  // Refresh options every time the screen mounts so newly-added website
  // rebbeim/tags appear without the user restarting the app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = await getShiurOptions();
        if (!cancelled) setOptions(opts);
      } finally {
        if (!cancelled) setLoadingOptions(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleTag = (t: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  const pickAudio = async () => {
    const dp = loadDocumentPicker();
    if (!dp?.getDocumentAsync) {
      Alert.alert(
        "Upload not available yet",
        "File uploads require a new app build that hasn't been published yet. Please check back after the next release.",
      );
      return;
    }
    const res = await dp.getDocumentAsync({
      type: "audio/*",
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled) return;
    const a = res.assets?.[0];
    if (!a) return;
    setAudio({
      uri: a.uri,
      name: a.name ?? `shiur-${Date.now()}.mp3`,
      mime: a.mimeType ?? "audio/mpeg",
      size: a.size ?? null,
    });
  };

  const pickPdf = async () => {
    const dp = loadDocumentPicker();
    if (!dp?.getDocumentAsync) {
      Alert.alert(
        "Upload not available yet",
        "File uploads require a new app build that hasn't been published yet. Please check back after the next release.",
      );
      return;
    }
    const res = await dp.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled) return;
    const a = res.assets?.[0];
    if (!a) return;
    setPdf({
      uri: a.uri,
      name: a.name ?? `mareh-mekomos-${Date.now()}.pdf`,
      mime: a.mimeType ?? "application/pdf",
      size: a.size ?? null,
    });
  };

  const validateAndConfirm = (): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!title.trim()) { Alert.alert("Missing title", "Please enter a title."); resolve(false); return; }
      if (!rebbe) { Alert.alert("Missing rebbe", "Please pick a rebbe."); resolve(false); return; }
      if (!date) { Alert.alert("Missing date", "Please pick a date."); resolve(false); return; }
      if (!uploaderName.trim()) { Alert.alert("Missing name", "Please enter your name as the uploader."); resolve(false); return; }
      if (!audio) {
        Alert.alert(
          "No audio attached",
          "This shiur won't have audio playback. Submit anyway?",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Submit anyway", style: "destructive", onPress: () => resolve(true) },
          ],
        );
        return;
      }
      resolve(true);
    });
  };

  const onSubmit = async () => {
    if (submitting) return;
    if (!user?.email) { Alert.alert("Not signed in", "Please sign in again."); return; }
    if (!canUpload) { Alert.alert("No upload permission", "An admin needs to grant you uploader access."); return; }
    const ok = await validateAndConfirm();
    if (!ok) return;
    setSubmitting(true);
    try {
      let audioUrl: string | null = null;
      let pdfUrl: string | null = null;
      if (audio) {
        setProgressLabel("Uploading audio…");
        setProgressPct(0);
        audioUrl = await uploadShiurFile(audio.uri, audio.name, audio.mime, "audio", (p) => setProgressPct(p));
      }
      if (pdf) {
        setProgressLabel("Uploading PDF…");
        setProgressPct(0);
        pdfUrl = await uploadShiurFile(pdf.uri, pdf.name, pdf.mime, "pdf", (p) => setProgressPct(p));
      }
      setProgressLabel("Saving shiur…");
      setProgressPct(99);
      await submitShiur({
        title: title.trim(),
        rebbe,
        date,
        tags: Array.from(selectedTags),
        description: description.trim(),
        series: series ? series : null,
        audioUrl,
        pdfUrl,
        uploadedBy: user.email,
        uploaderName: uploaderName.trim(),
      });
      setProgressPct(100);
      Alert.alert(
        "Shiur uploaded",
        "Your shiur is live. Subscribers will be notified shortly.",
        [{ text: "OK", onPress: () => reset() }],
      );
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message ?? "Please try again.");
    } finally {
      setSubmitting(false);
      setProgressLabel("");
      setProgressPct(0);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: Colors.bg }]} edges={["bottom"]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: 120 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.h1, { color: Colors.text }]}>Upload Shiur</Text>
        <View style={[styles.brandRule, { backgroundColor: StaticColors.gold }]} />
        <Text style={[styles.subtle, { color: Colors.textMuted }]}>
          {isAdmin ? "Admin upload" : "Authorized uploader"}
        </Text>

        {/* Title */}
        <Field label="Title" required color={Colors.text}>
          <TextInput
            style={[styles.input, { color: Colors.text, borderColor: Colors.border, backgroundColor: Colors.surface }]}
            placeholder="e.g. Halachos of Shabbos"
            placeholderTextColor={Colors.textFaint}
            value={title}
            onChangeText={setTitle}
            editable={!submitting}
          />
        </Field>

        {/* Rebbe */}
        <Field label="Rebbe" required color={Colors.text}>
          <TouchableOpacity
            style={[styles.pickerBtn, { borderColor: Colors.border, backgroundColor: Colors.surface }]}
            onPress={() => setRebbePickerOpen(true)}
            disabled={submitting || loadingOptions}
          >
            <Text style={{ color: rebbe ? Colors.text : Colors.textFaint }}>
              {rebbe || (loadingOptions ? "Loading…" : "Select rebbe")}
            </Text>
            <Ionicons name="chevron-down" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </Field>

        {/* Date */}
        <Field label="Date" required color={Colors.text}>
          <TouchableOpacity
            style={[styles.pickerBtn, { borderColor: Colors.border, backgroundColor: Colors.surface }]}
            onPress={() => setDatePickerOpen(true)}
            disabled={submitting}
          >
            <Text style={{ color: date ? Colors.text : Colors.textFaint }}>
              {date ? formatDisplayDate(date) : "Pick a date"}
            </Text>
            <Ionicons name="calendar-outline" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </Field>

        {/* Uploader name */}
        <Field label="Your name" required color={Colors.text}>
          <TextInput
            style={[styles.input, { color: Colors.text, borderColor: Colors.border, backgroundColor: Colors.surface }]}
            placeholder="Shown as the uploader"
            placeholderTextColor={Colors.textFaint}
            value={uploaderName}
            onChangeText={setUploaderName}
            editable={!submitting}
          />
        </Field>

        {/* Description */}
        <Field label="Description" color={Colors.text} hint="Optional">
          <TextInput
            style={[styles.input, styles.multiline, { color: Colors.text, borderColor: Colors.border, backgroundColor: Colors.surface }]}
            placeholder="Optional summary of the shiur"
            placeholderTextColor={Colors.textFaint}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
            editable={!submitting}
          />
        </Field>

        {/* Tags */}
        <Field label="Tags" color={Colors.text} hint="Tap to toggle">
          {options.tags.length === 0 ? (
            <Text style={[styles.hint, { color: Colors.textFaint }]}>No tags configured yet.</Text>
          ) : (
            <View style={styles.chipRow}>
              {options.tags.map((t) => {
                const on = selectedTags.has(t);
                return (
                  <TouchableOpacity
                    key={t}
                    onPress={() => toggleTag(t)}
                    disabled={submitting}
                    style={[
                      styles.chip,
                      { borderColor: on ? StaticColors.gold : Colors.border, backgroundColor: on ? StaticColors.goldOpacity15 : Colors.surface },
                    ]}
                  >
                    <Text style={{ color: on ? StaticColors.gold : Colors.text, fontWeight: on ? "700" : "500", fontSize: 13 }}>{t}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </Field>

        {/* Series */}
        <Field label="Series" color={Colors.text} hint="Optional">
          <TouchableOpacity
            style={[styles.pickerBtn, { borderColor: Colors.border, backgroundColor: Colors.surface }]}
            onPress={() => setSeriesPickerOpen(true)}
            disabled={submitting || loadingOptions}
          >
            <Text style={{ color: series ? Colors.text : Colors.textFaint }}>
              {series || (loadingOptions ? "Loading…" : "(none)")}
            </Text>
            <Ionicons name="chevron-down" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </Field>

        {/* Audio file */}
        <Field label="Audio file" color={Colors.text} hint="Recommended (mp3 / m4a)">
          <TouchableOpacity
            style={[styles.fileBtn, { borderColor: audio ? StaticColors.gold : Colors.border, backgroundColor: Colors.surface }]}
            onPress={pickAudio}
            disabled={submitting}
          >
            <Ionicons name={audio ? "musical-notes" : "cloud-upload-outline"} size={20} color={audio ? StaticColors.gold : Colors.textMuted} />
            <Text style={{ color: audio ? Colors.text : Colors.textMuted, marginLeft: 10, flex: 1 }} numberOfLines={1}>
              {audio ? audio.name : "Choose audio"}
            </Text>
            {audio && (
              <TouchableOpacity onPress={() => setAudio(null)} hitSlop={10} disabled={submitting}>
                <Ionicons name="close-circle" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </Field>

        {/* PDF */}
        <Field label="Mareh Mekomos PDF" color={Colors.text} hint="Optional">
          <TouchableOpacity
            style={[styles.fileBtn, { borderColor: pdf ? StaticColors.gold : Colors.border, backgroundColor: Colors.surface }]}
            onPress={pickPdf}
            disabled={submitting}
          >
            <Ionicons name={pdf ? "document-text" : "document-outline"} size={20} color={pdf ? StaticColors.gold : Colors.textMuted} />
            <Text style={{ color: pdf ? Colors.text : Colors.textMuted, marginLeft: 10, flex: 1 }} numberOfLines={1}>
              {pdf ? pdf.name : "Choose PDF"}
            </Text>
            {pdf && (
              <TouchableOpacity onPress={() => setPdf(null)} hitSlop={10} disabled={submitting}>
                <Ionicons name="close-circle" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        </Field>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submit, { backgroundColor: StaticColors.navy, opacity: submitting ? 0.7 : 1 }]}
          onPress={onSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ActivityIndicator color={StaticColors.cream} />
              <Text style={styles.submitText}>
                {progressLabel || "Working…"} {progressPct ? `${progressPct}%` : ""}
              </Text>
            </View>
          ) : (
            <Text style={styles.submitText}>Upload shiur</Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Date picker */}
      <InlineDatePicker
        visible={datePickerOpen}
        valueIso={date}
        onClose={() => setDatePickerOpen(false)}
        onPick={(iso) => { setDate(iso); setDatePickerOpen(false); }}
      />

      {/* Rebbe picker */}
      <ListPicker
        visible={rebbePickerOpen}
        title="Select rebbe"
        items={options.rebbeim}
        value={rebbe}
        onClose={() => setRebbePickerOpen(false)}
        onPick={(v) => { setRebbe(v); setRebbePickerOpen(false); }}
      />

      {/* Series picker (with explicit "(none)" first option) */}
      <ListPicker
        visible={seriesPickerOpen}
        title="Select series"
        items={["(none)", ...options.series]}
        value={series || "(none)"}
        onClose={() => setSeriesPickerOpen(false)}
        onPick={(v) => { setSeries(v === "(none)" ? "" : v); setSeriesPickerOpen(false); }}
      />
    </SafeAreaView>
  );
}

function Field({ label, required, hint, color, children }: {
  label: string; required?: boolean; hint?: string; color: string; children: React.ReactNode;
}) {
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text style={[styles.fieldLabel, { color }]}>{label}{required ? " *" : ""}</Text>
        {hint ? <Text style={styles.fieldHint}>  {hint}</Text> : null}
      </View>
      <View style={{ marginTop: 6 }}>{children}</View>
    </View>
  );
}

function ListPicker({ visible, title, items, value, onClose, onPick }: {
  visible: boolean; title: string; items: string[]; value: string;
  onClose: () => void; onPick: (v: string) => void;
}) {
  const Colors = useYtcColors();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={dpStyles.backdrop} onPress={onClose}>
        <Pressable style={[dpStyles.card, { backgroundColor: Colors.surface, maxHeight: "70%" }]} onPress={() => {}}>
          <Text style={[dpStyles.monthLabel, { color: Colors.text, marginBottom: 8 }]}>{title}</Text>
          {items.length === 0 ? (
            <Text style={{ color: Colors.textFaint, paddingVertical: 12 }}>Nothing configured yet.</Text>
          ) : (
            <ScrollView>
              {items.map((it) => {
                const on = it === value;
                return (
                  <TouchableOpacity
                    key={it}
                    onPress={() => onPick(it)}
                    style={{
                      paddingVertical: 12, paddingHorizontal: 8,
                      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
                      flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: Colors.text, fontWeight: on ? "700" : "500" }}>{it}</Text>
                    {on && <Ionicons name="checkmark" size={18} color={StaticColors.gold} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          <TouchableOpacity onPress={onClose} style={dpStyles.cancelBtn}>
            <Text style={[dpStyles.cancelBtnText, { color: Colors.textMuted }]}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Inline calendar (clone of components/ytc/SubmitSimchaForm's
//    InlineDatePicker; that one isn't exported and I don't want to widen
//    its public surface for one extra caller). ────────────────────────
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function InlineDatePicker({ visible, valueIso, onClose, onPick }: {
  visible: boolean; valueIso: string; onClose: () => void; onPick: (iso: string) => void;
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
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: Array<{ day: number | null; iso: string | null }> = [];
    for (let i = 0; i < firstDay; i++) out.push({ day: null, iso: null });
    for (let d = 1; d <= daysInMonth; d++) out.push({ day: d, iso: toIsoDate(new Date(year, month, d)) });
    return out;
  }, [viewDate]);
  const monthLabel = viewDate.toLocaleString("en-US", { month: "long", year: "numeric" });
  const todayIso = toIsoDate(new Date());
  const goPrev = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const goNext = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  const Colors = useYtcColors();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={dpStyles.backdrop} onPress={onClose}>
        <Pressable style={[dpStyles.card, { backgroundColor: Colors.surface }]} onPress={() => {}}>
          <View style={dpStyles.navRow}>
            <TouchableOpacity onPress={goPrev} hitSlop={8} style={[dpStyles.navBtn, { backgroundColor: Colors.surfaceAlt }]}>
              <Ionicons name="chevron-back" size={20} color={Colors.text} />
            </TouchableOpacity>
            <Text style={[dpStyles.monthLabel, { color: Colors.text }]}>{monthLabel}</Text>
            <TouchableOpacity onPress={goNext} hitSlop={8} style={[dpStyles.navBtn, { backgroundColor: Colors.surfaceAlt }]}>
              <Ionicons name="chevron-forward" size={20} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <View style={dpStyles.weekRow}>
            {WEEKDAYS.map((w, i) => <Text key={i} style={[dpStyles.weekday, { color: Colors.textFaint }]}>{w}</Text>)}
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
                    isToday && !isPicked && { borderWidth: 1, borderColor: StaticColors.gold },
                    isPicked && { backgroundColor: StaticColors.gold },
                  ]}
                  onPress={() => onPick(c.iso!)}
                >
                  <Text style={[dpStyles.cellText, { color: isPicked ? StaticColors.navy : Colors.text }]}>{c.day}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={dpStyles.footer}>
            <TouchableOpacity style={[dpStyles.todayBtn, { backgroundColor: Colors.surfaceAlt }]} onPress={() => onPick(todayIso)}>
              <Text style={[dpStyles.todayBtnText, { color: Colors.text }]}>Today</Text>
            </TouchableOpacity>
            <TouchableOpacity style={dpStyles.cancelBtn} onPress={onClose}>
              <Text style={[dpStyles.cancelBtnText, { color: Colors.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const CELL_SIZE = 40;
const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { paddingHorizontal: 20 },
  h1: {
    fontSize: 26, fontWeight: "700", textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
  },
  brandRule: { width: 60, height: 2, alignSelf: "center", marginVertical: 8, opacity: 0.85 },
  subtle: { textAlign: "center", fontSize: 12, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "700", letterSpacing: 0.4 },
  fieldHint: { fontSize: 11, color: "#999", marginLeft: 6 },
  hint: { fontSize: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  multiline: { minHeight: 84, textAlignVertical: "top", paddingTop: 10 },
  pickerBtn: {
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1 },
  fileBtn: {
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 14,
    flexDirection: "row", alignItems: "center",
  },
  submit: {
    marginTop: 24, borderRadius: 12, paddingVertical: 16, alignItems: "center", justifyContent: "center",
  },
  submitText: { color: StaticColors.cream, fontSize: 16, fontWeight: "600" },
});

const dpStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 360, borderRadius: 14, padding: 16, gap: 10 },
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  navBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 16 },
  monthLabel: { fontSize: 16, fontWeight: "700" },
  weekRow: { flexDirection: "row" },
  weekday: { width: CELL_SIZE, textAlign: "center", fontSize: 11, fontWeight: "600", paddingVertical: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: CELL_SIZE, height: CELL_SIZE, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  cellText: { fontSize: 14, fontWeight: "500" },
  footer: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  todayBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  todayBtnText: { fontSize: 13, fontWeight: "600" },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 8, alignItems: "center" },
  cancelBtnText: { fontSize: 13, fontWeight: "600" },
});
