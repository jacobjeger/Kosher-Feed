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

// IMPORTANT: setting `platforms.ios = null` REPLACES the dependency's
// entire `platforms` object, which wipes out the Android config the
// package ships in its own react-native.config.js. @react-native-firebase/app
// ships a CUSTOM android `packageImportPath`
// (io.invertase.firebase.app.ReactNativeFirebaseAppPackage) to disambiguate;
// without it, autolinking falls back to a wrong guess
// (io.invertase.firebase.ReactNativeFirebaseAppPackage — missing `.app`) and
// the Android build fails with "cannot find symbol ReactNativeFirebaseAppPackage"
// in the generated PackageList.java. So we MUST restore the android
// packageImportPath here while nulling iOS. (This broke every Android build
// from early July until this fix.)
module.exports = {
  dependencies: {
    "@react-native-firebase/app": {
      platforms: {
        ios: null,
        android: {
          packageImportPath: "import io.invertase.firebase.app.ReactNativeFirebaseAppPackage;",
        },
      },
    },
    "@react-native-firebase/messaging": {
      platforms: {
        ios: null,
        android: {
          packageImportPath: "import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingPackage;",
        },
      },
    },
  },
};
