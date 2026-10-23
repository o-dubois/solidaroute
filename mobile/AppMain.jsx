import './src/i18n';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider }    from 'react-native-safe-area-context';
import { StatusBar }           from 'expo-status-bar';
import { StripeProvider }      from '@stripe/stripe-react-native';
import { AppConfigProvider, useAppConfig } from './src/context/AppConfigContext';
import { AuthProvider }        from './src/context/AuthContext';
import RootNavigator           from './src/navigation/RootNavigator';

// Must be inside AppConfigProvider so it can read stripePublishableKey from context.
function StripeWrapper({ children }) {
  const { stripePublishableKey } = useAppConfig();
  return (
    <StripeProvider publishableKey={stripePublishableKey || 'pk_placeholder'}>
      {children}
    </StripeProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <AppConfigProvider>
          <StripeWrapper>
            <AuthProvider>
              <RootNavigator />
              <StatusBar style="auto" />
            </AuthProvider>
          </StripeWrapper>
        </AppConfigProvider>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
