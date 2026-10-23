/**
 * No-op stub for react-native-screens.
 *
 * Expo SDK 55 / react-native 0.83.4 have a C++ API incompatibility with
 * react-native-screens that causes EAS Build to fail. Since the app uses
 * @react-navigation/bottom-tabs which handles a missing/disabled screens
 * module gracefully (falls back to plain Views), we replace the entire
 * package with this stub that has zero native code.
 */
const { View } = require('react-native');

function enableScreens() {}
function screensEnabled() { return false; }

module.exports = {
  enableScreens,
  screensEnabled,
  Screen: View,
  ScreenContainer: View,
  ScreenStack: View,
  ScreenStackHeaderConfig: View,
  NativeScreen: View,
  NativeScreenContainer: View,
  ScreenContainerNativeComponent: View,
};
