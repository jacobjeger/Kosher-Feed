// React Native autolinking config.
//
// Purpose: disable iOS autolinking for @react-native-firebase/*. The
// npm packages stay installed (Android needs them for FCM), but their
// podspecs won't be added to the iOS Podfile, so CocoaPods won't try
// to install FirebaseCoreInternal / GoogleUtilities on iOS builds.
// Complements app.config.js which already strips the Expo config
// plugins from iOS.
//
// The iOS build previously failed at "Install pods" with:
//   [!] The following Swift pods cannot yet be integrated as static
//       libraries:
//   The Swift pod `FirebaseCoreInternal` depends upon `GoogleUtilities`,
//   which does not define modules.
// Once autolinking is off for these packages on iOS, none of that
// dependency chain is pulled in.

module.exports = {
  dependencies: {
    "@react-native-firebase/app": {
      platforms: { ios: null },
    },
    "@react-native-firebase/messaging": {
      platforms: { ios: null },
    },
  },
};
