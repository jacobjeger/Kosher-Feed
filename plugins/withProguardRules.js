// Keep rules that R8 needs in order not to break notifications.
//
// withAndroidMinification.js turns R8 on for release builds. R8 renames
// every method it isn't told to keep — including the two private hooks
// Java serialization looks up REFLECTIVELY by name:
//
//   private void writeObject(java.io.ObjectOutputStream)
//   private void readObject(java.io.ObjectInputStream)
//
// Once those are renamed, ObjectOutputStream can't find them, silently
// falls back to default field-by-field serialization, and then throws on
// the first field whose type isn't Serializable. expo-notifications'
// NotificationContent is exactly that shape: it holds the sound as an
// `android.net.Uri mSound` and defines writeObject/readObject to write it
// out as a String. Minified, scheduling any notification with a sound died
// with:
//
//   E expo-notifications: Action expo.modules.notifications.NOTIFICATION_EVENT
//     failed: android.net.Uri$HierarchicalUri
//   W System.err: java.io.NotSerializableException: android.net.Uri$HierarchicalUri
//     at expo.modules.notifications.service.NotificationsService.v(SourceFile:34)
//
// expo-notifications ships `-keep class expo.modules.notifications.** {*;}`
// in its own android/proguard-rules.pro, but its build.gradle never
// declares that file as `consumerProguardFiles`, so the rule never reaches
// the app build. We apply it here ourselves.
//
// EAS regenerates android/ from app.json on every build, so a hand-edit of
// android/app/proguard-rules.pro would be thrown away — the plugin path is
// the only one that survives prebuild, same as withAndroidAbiFilter.js.

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const MARKER = "# --- ShiurPod keep rules (withProguardRules.js) ---";

const RULES = `
${MARKER}

# Java serialization hooks are found by reflection; R8 must not rename them.
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# expo-notifications' own rule, which its AAR never actually contributes.
-keep class expo.modules.notifications.** { *; }
`;

module.exports = function withProguardRules(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const file = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "proguard-rules.pro",
      );
      const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      // Idempotent: a second prebuild over an existing android/ must not
      // append the block twice.
      if (!contents.includes(MARKER)) {
        fs.writeFileSync(file, contents + RULES);
      }
      return config;
    },
  ]);
};
