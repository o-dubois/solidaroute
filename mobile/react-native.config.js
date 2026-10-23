/**
 * Exclude react-native-screens from native autolinking.
 *
 * react-native-screens@4.23.0 has C++ and TypeScript codegen files that are
 * incompatible with react-native@0.83.4's build toolchain (ShadowNode::Shared
 * deprecated, ShadowViewMutation API changes). Excluding it from autolinking
 * prevents Gradle from compiling any of its native code. The JS module is
 * still available; we call enableScreens(false) in App.js so @react-navigation
 * uses plain Views instead of native screen containers.
 */
module.exports = {
  dependencies: {
    'react-native-screens': {
      platforms: {
        android: null,
        ios: null,
      },
    },
  },
};
