import './src/i18n';
import { enableScreens } from 'react-native-screens';
import { NavigationContainer } from '@react-navigation/native';

enableScreens(false);
import { SafeAreaProvider }    from 'react-native-safe-area-context';
import { StatusBar }           from 'expo-status-bar';
import { StripeProvider }      from '@stripe/stripe-react-native';
import { AppConfigProvider, useAppConfig } from './src/context/AppConfigContext';
import { AuthProvider }        from './src/context/AuthContext';
import RootNavigator           from './src/navigation/RootNavigator';

// Wraps the app with StripeProvider once the publishable key is loaded from config.
// Renders children without Stripe context until the key arrives (safe — the
// payment step is never reached before config has loaded).
function StripeWrapper({ children }) {
  const { stripePublishableKey } = useAppConfig();
  if (!stripePublishableKey) return children;
  return (
    <StripeProvider publishableKey={stripePublishableKey}>
      {children}
    </StripeProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <AppConfigProvider>
          <AuthProvider>
            <StripeWrapper>
              <RootNavigator />
              <StatusBar style="auto" />
            </StripeWrapper>
          </AuthProvider>
        </AppConfigProvider>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
