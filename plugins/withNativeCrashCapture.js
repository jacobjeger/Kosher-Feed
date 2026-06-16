// Expo config plugin: install native uncaught-exception handlers on Android
// and iOS that write a sidecar JSON file at crash time. On the next launch,
// JS code in lib/telemetry/native-crash-replay.ts reads the file, POSTs it
// to /api/v1/ingest/native-crash, and deletes the file.
//
// Why: RN's ErrorUtils.setGlobalHandler does NOT catch Java/Kotlin or
// Obj-C/Swift crashes — when those happen the process dies before JS can
// react. The sidecar pattern is the standard third-party-free fix.
//
// Effect requires a new APK / IPA. Shipping this plugin to an existing build
// via OTA is harmless (the JS-side replayer just finds no sidecar file).

const { withMainApplication, withAppDelegate } = require("@expo/config-plugins");

const ANDROID_INSTALL = `
    // BEGIN ShiurPod native crash capture
    // Capture the EXISTING handler (RN/Hermes installs its own) BEFORE we swap
    // ours in — otherwise the chain call below would re-invoke ourselves and
    // infinite-loop.
    val __shiurpodPreviousUE = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        val dir = applicationContext.filesDir
        val out = java.io.File(dir, "last_native_crash.json")
        val sw = java.io.StringWriter()
        throwable.printStackTrace(java.io.PrintWriter(sw))
        val safe = sw.toString().replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"").replace("\\n", "\\\\n").replace("\\r", "")
        val msg = (throwable.message ?: throwable.javaClass.simpleName)
          .replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"")
        val excName = throwable.javaClass.name
        val ts = System.currentTimeMillis()
        val threadName = thread.name.replace("\\"", "\\\\\\"")
        val json = "{\\"ts\\":" + ts + ",\\"thread\\":\\"" + threadName + "\\",\\"exceptionName\\":\\"" + excName + "\\",\\"message\\":\\"" + msg + "\\",\\"stack\\":\\"" + safe + "\\"}"
        out.writeText(json)
      } catch (_: Throwable) {}
      // Defer to the captured previous handler so RN's own crash reporting
      // (and the OS) still see the unhandled exception and tear the process
      // down. Without this the app would silently hang post-crash.
      __shiurpodPreviousUE?.uncaughtException(thread, throwable)
    }
    // END ShiurPod native crash capture
`;

const IOS_INSTALL = `
  // BEGIN ShiurPod native crash capture
  NSSetUncaughtExceptionHandler { exception in
    let dir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
    let path = (dir as NSString).appendingPathComponent("last_native_crash.json")
    let payload: [String: Any] = [
      "ts": Int(Date().timeIntervalSince1970 * 1000),
      "exceptionName": exception.name.rawValue,
      "message": exception.reason ?? "",
      "stack": exception.callStackSymbols.joined(separator: "\\n"),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      try? data.write(to: URL(fileURLWithPath: path))
    }
  }
  // END ShiurPod native crash capture
`;

function withAndroid(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("ShiurPod native crash capture")) return cfg;

    // Insert into onCreate() right after super.onCreate() — earliest point
    // where Application is up and we can hook the global UE handler.
    const marker = /override fun onCreate\(\) \{[\s\S]*?super\.onCreate\(\)/;
    const m = src.match(marker);
    if (m) {
      const idx = src.indexOf(m[0]) + m[0].length;
      src = src.slice(0, idx) + "\n" + ANDROID_INSTALL + src.slice(idx);
    } else {
      // Java fallback
      const jmarker = /super\.onCreate\(\);/;
      const jm = src.match(jmarker);
      if (jm) {
        const idx = src.indexOf(jm[0]) + jm[0].length;
        const javaPatch = ANDROID_INSTALL
          .replace(/Thread\.setDefaultUncaughtExceptionHandler \{[^]*?\}\s*$/, "") // Kotlin form won't fit Java; skip silently
        ;
        // For Java we just leave a TODO comment; ShiurPod is Kotlin in practice.
        src = src.slice(0, idx) + "\n    // ShiurPod native crash capture: requires Kotlin MainApplication\n" + src.slice(idx);
      }
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

function withIOS(config) {
  return withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes("ShiurPod native crash capture")) return cfg;
    // Insert near the top of didFinishLaunchingWithOptions, before super call.
    const marker = /func application\([^)]*didFinishLaunchingWithOptions[^)]*\)[^{]*\{/;
    const m = src.match(marker);
    if (m) {
      const idx = src.indexOf(m[0]) + m[0].length;
      src = src.slice(0, idx) + "\n" + IOS_INSTALL + src.slice(idx);
      cfg.modResults.contents = src;
    }
    return cfg;
  });
}

module.exports = function withNativeCrashCapture(config) {
  config = withAndroid(config);
  config = withIOS(config);
  return config;
};
