/**
 * RootNavigator — top-level navigator.
 *
 * Shows a loading spinner while the auth session is being restored from
 * SecureStore. Once resolved:
 *   - No user → AuthStack (Login / Register / ForgotPassword)
 *   - client  → ClientTabs
 *   - driver  → DriverTabs
 *   - admin roles → simple placeholder (admin stays web-only)
 */
import { View, ActivityIndicator } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { MessagesProvider } from '../context/MessagesContext';
import AuthStack   from './AuthStack';
import ClientTabs  from './ClientTabs';
import DriverTabs  from './DriverTabs';
import { useColors } from '../theme';

export default function RootNavigator() {
  const { user, loading } = useAuth();
  const c = useColors();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: c.screenBg }}>
        <ActivityIndicator size="large" color={c.teal600} />
      </View>
    );
  }

  if (!user) {
    return <AuthStack />;
  }

  if (user.role === 'client') return (
    <MessagesProvider><ClientTabs /></MessagesProvider>
  );
  if (user.role === 'driver') return (
    <MessagesProvider><DriverTabs /></MessagesProvider>
  );

  // operator / superadmin / ticket_master — not supported in the mobile app
  return <AuthStack />;
}
