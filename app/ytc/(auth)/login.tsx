// YTC: login + sign-up screen. Verbatim port from
// /tmp/ytc-source/expo-app/app/(auth)/login.tsx with these changes:
//  - firebase/auth top-level imports → lib/ytc/firebase wrappers
//    (signInEmailPassword, createUserEmailPassword) so the SDK loads
//    only when the user submits.
//  - Colors → ytcColors
//  - submitAccessRequest path
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { signInEmailPassword, handleYtcSignup } from "@/lib/ytc/firebase";
import { ytcColors as Colors } from "@/constants/ytcColors";
import { YtcFocusable } from "@/components/ytc/YtcFocusable";

/** Map Firebase auth error codes to short, user-readable strings. */
function friendlyAuthError(error: any): string {
  const code = (error?.code || "").toString();
  const msg = (error?.message || "").toString();
  // Codes appear in error.code on @react-native-firebase, embedded in
  // error.message on the firebase JS SDK ("Firebase: Error (auth/...)").
  const codeFromMsg = msg.match(/\(auth\/[\w-]+\)/)?.[0]?.replace(/[()]/g, "") || "";
  const c = code || codeFromMsg;
  switch (c) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return "Invalid email or password. Please try again.";
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/email-already-in-use":
      return "An account with this email already exists. Try signing in instead.";
    case "auth/weak-password":
      return "Password is too weak. Use at least 6 characters.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Please wait a minute and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Please contact alumni@ytchaim.com.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export default function LoginScreen() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleAuth = async () => {
    if (isSignUp) {
      if (!firstName.trim() || !lastName.trim()) { Alert.alert("Error", "Please enter your first and last name."); return; }
      if (password !== confirmPassword) { Alert.alert("Error", "Passwords don't match."); return; }
    }
    if (!email || !password) { Alert.alert("Error", "Please fill in all required fields."); return; }

    setIsLoading(true);
    try {
      if (isSignUp) {
        // handleYtcSignup creates the auth user, writes the
        // accessRequests doc, fires the admin signup-notification
        // email, and (if auto-approved) the user's welcome email.
        // Mirrors the website's lib/auth-context.tsx signup flow so
        // app + web signups produce identical Firestore + email
        // side-effects.
        await handleYtcSignup({
          email: email.trim(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          graduationYear: null,
        });
      } else {
        await signInEmailPassword(email.trim(), password);
      }
    } catch (error: any) {
      Alert.alert(isSignUp ? "Sign-up failed" : "Sign-in failed", friendlyAuthError(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Image
              source={require("@/assets/images/ytc-logo.png")}
              style={styles.logoImage}
              resizeMode="contain"
            />
            <Text style={styles.title}>Yeshiva Toras Chaim Alumni</Text>
            <Text style={styles.subtitle}>{isSignUp ? "Create your account" : "Sign in to access the alumni portal"}</Text>
          </View>

          {isSignUp && (
            <View style={styles.infoBox}>
              <Text style={styles.infoTitle}>How approval works:</Text>
              <Text style={styles.bullet}>• If your email is in our alumni database, you will be approved automatically</Text>
              <Text style={styles.bullet}>• Otherwise, your request will be reviewed by an administrator</Text>
              <Text style={styles.bullet}>• You will receive access once approved</Text>
            </View>
          )}

          <View style={styles.form}>
            {isSignUp && (
              <View style={styles.row}>
                <View style={[styles.fieldGroup, { flex: 1, marginRight: 8 }]}>
                  <Text style={styles.label}>First Name <Text style={styles.required}>*</Text></Text>
                  <TextInput style={styles.input} placeholder="Moshe" value={firstName} onChangeText={setFirstName} autoCapitalize="words" />
                </View>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>Last Name <Text style={styles.required}>*</Text></Text>
                  <TextInput style={styles.input} placeholder="Cohen" value={lastName} onChangeText={setLastName} autoCapitalize="words" />
                </View>
              </View>
            )}

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email <Text style={styles.required}>*</Text></Text>
              <TextInput style={styles.input} placeholder="email@example.com" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password <Text style={styles.required}>*</Text></Text>
              <View style={styles.passwordRow}>
                <TextInput style={[styles.input, { flex: 1 }]} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry={!showPassword} autoComplete={isSignUp ? "new-password" : "password"} />
                <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={styles.eyeBtn} hitSlop={8}>
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color={Colors.navyOpacity50}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {isSignUp && (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Confirm Password <Text style={styles.required}>*</Text></Text>
                <View style={styles.passwordRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="Confirm Password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry={!showConfirmPassword} autoComplete="new-password" />
                  <TouchableOpacity onPress={() => setShowConfirmPassword((v) => !v)} style={styles.eyeBtn} hitSlop={8}>
                    <Ionicons
                      name={showConfirmPassword ? "eye-off-outline" : "eye-outline"}
                      size={20}
                      color={Colors.navyOpacity50}
                    />
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>

          <YtcFocusable style={[styles.primaryBtn, isLoading && styles.primaryBtnDisabled]} onPress={handleAuth} disabled={isLoading} focusRadius={12}>
            {isLoading ? <ActivityIndicator color={Colors.cream} /> : <Text style={styles.primaryBtnText}>{isSignUp ? "Sign Up" : "Sign In"}</Text>}
          </YtcFocusable>

          <YtcFocusable onPress={() => setIsSignUp((v) => !v)} disabled={isLoading} style={styles.toggleBtn} focusRadius={6}>
            <Text style={styles.toggleText}>{isSignUp ? "Already have an account? Sign in" : "Don't have an account? Sign up"}</Text>
          </YtcFocusable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.cream },
  container: { padding: 24, paddingBottom: 48 },
  header: { alignItems: "center", paddingTop: 40, marginBottom: 24 },
  logoImage: { width: 110, height: 110, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: "bold", color: Colors.navy, textAlign: "center", fontFamily: Platform.OS === "ios" ? "Georgia" : "serif" },
  subtitle: { fontSize: 14, color: Colors.navyOpacity70, marginTop: 6, textAlign: "center" },
  infoBox: { backgroundColor: Colors.navyOpacity05, borderRadius: 12, borderWidth: 1, borderColor: Colors.navyOpacity10, padding: 16, marginBottom: 20 },
  infoTitle: { fontSize: 14, fontWeight: "600", color: Colors.navy, marginBottom: 8 },
  bullet: { fontSize: 12, color: Colors.navyOpacity70, marginBottom: 4, lineHeight: 18 },
  form: { gap: 16, marginBottom: 24 },
  row: { flexDirection: "row" },
  fieldGroup: {},
  label: { fontSize: 14, fontWeight: "500", color: Colors.navy, marginBottom: 6 },
  required: { color: Colors.error },
  input: { backgroundColor: Colors.white, borderRadius: 10, borderWidth: 1, borderColor: Colors.goldOpacity30, padding: 14, fontSize: 15, color: Colors.navy },
  passwordRow: { flexDirection: "row", alignItems: "center" },
  // Eye icon overlays the right edge of the password input (negative
  // marginLeft pulls it back over the input). 44px wide tap target +
  // 12px padding centers a 20px Ionicon inside the input's vertical
  // range. Replaces the previous emoji-based 🙈 / 👁 which rendered
  // inconsistently across Android system fonts.
  eyeBtn: { padding: 12, marginLeft: -44, alignItems: "center", justifyContent: "center" },
  primaryBtn: { backgroundColor: Colors.navy, borderRadius: 12, paddingVertical: 16, alignItems: "center", marginBottom: 16 },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: Colors.cream, fontSize: 16, fontWeight: "600" },
  toggleBtn: { paddingVertical: 8, alignItems: "center" },
  toggleText: { textAlign: "center", fontSize: 14, color: Colors.navy },
});
