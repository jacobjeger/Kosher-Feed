// YTC: access-code modal. Validates the user's input against the
// admin-managed code from useRemoteConfig().config.ytcUnlockCode and
// (on success) sets the persistent unlock flag via tryUnlock.
//
// Quarantine: this screen imports nothing from Firebase or any /ytc
// route component. It's safe to navigate to without dragging YTC
// runtime code into the bundle. Phase 3+ will create app/ytc/* routes
// that DO import Firebase; this screen only sets the flag.
import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAppColorScheme } from "@/lib/useAppColorScheme";
import Colors from "@/constants/colors";
import { useRemoteConfig } from "@/contexts/RemoteConfigContext";
import { tryUnlock } from "@/lib/ytc/unlock";
import { mediumHaptic, lightHaptic } from "@/lib/haptics";

export default function YtcUnlockScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useAppColorScheme() === "dark";
  const colors = isDark ? Colors.dark : Colors.light;
  const { config } = useRemoteConfig();
  const expected = (config.ytcUnlockCode as string | null | undefined) || null;

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Feature kill switch: if the admin hasn't set a code (or cleared it),
  // there's nothing to validate against. Show a "feature unavailable"
  // state instead of a useless input. Same UI, just with the input
  // disabled and a clear message.
  const featureEnabled = !!expected;

  const onSubmit = async () => {
    if (submitting || !featureEnabled) return;
    setSubmitting(true);
    try {
      const ok = await tryUnlock(code, expected);
      if (ok) {
        mediumHaptic();
        // Phase 3+ will register /ytc as an auth-gated subtree. For now
        // we just dismiss the modal and let the caller's settings UI
        // pick up the flag change via useYtcUnlocked().
        router.back();
      } else {
        Alert.alert("Incorrect code", "The access code you entered is not valid.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => { lightHaptic(); router.back(); };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.root, { backgroundColor: colors.background }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.body, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={close} style={styles.closeBtn} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.text} />
        </Pressable>

        <Text style={[styles.title, { color: colors.text }]}>YTC Alumni Access</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {featureEnabled
            ? "Enter the access code provided by your administrator."
            : "This feature is currently unavailable. Please check back later."}
        </Text>

        <TextInput
          value={code}
          onChangeText={setCode}
          editable={featureEnabled}
          placeholder="Access code"
          placeholderTextColor={colors.textSecondary}
          autoFocus={featureEnabled}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={onSubmit}
          returnKeyType="go"
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.surface,
              borderColor: colors.border,
              opacity: featureEnabled ? 1 : 0.5,
            },
          ]}
        />

        <Pressable
          onPress={onSubmit}
          disabled={submitting || !code || !featureEnabled}
          style={({ pressed }) => [
            styles.submit,
            {
              backgroundColor: colors.accent,
              opacity: !featureEnabled || !code || submitting ? 0.4 : pressed ? 0.85 : 1,
            },
          ]}
        >
          <Text style={styles.submitText}>{submitting ? "Checking…" : "Unlock"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingHorizontal: 20, flex: 1 },
  closeBtn: { alignSelf: "flex-start", padding: 6, marginLeft: -6 },
  title: { fontSize: 24, fontWeight: "700", marginTop: 18 },
  subtitle: { fontSize: 14, marginTop: 6, lineHeight: 20 },
  input: {
    marginTop: 28,
    fontSize: 18,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  submit: {
    marginTop: 18,
    paddingVertical: 14,
    borderRadius: 10,
  },
  submitText: { color: "#fff", fontWeight: "600", fontSize: 16, textAlign: "center" },
});
