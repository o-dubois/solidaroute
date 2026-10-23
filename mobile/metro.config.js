const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Block react-native-screens Fabric component files from being processed
// by @react-native/codegen when newArchEnabled is false.
const originalResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.includes('react-native-screens') && moduleName.includes('fabric')) {
    return { type: 'empty' };
  }
  if (originalResolver) {
    return originalResolver(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
