import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DriverDashboardScreen from '../screens/driver/DashboardScreen';
import AvailableTripsScreen  from '../screens/driver/AvailableTripsScreen';
import DriverMyTripsScreen   from '../screens/driver/MyTripsScreen';
import MessagesScreen        from '../screens/messages/MessagesScreen';
import DriverProfileScreen   from '../screens/driver/ProfileScreen';
import { useMessages }       from '../context/MessagesContext';
import { useColors } from '../theme';

const Tab = createBottomTabNavigator();

function TabIcon({ label }) {
  const icons = {
    Dashboard: '🏠',
    Available: '📍',
    MyTrips:   '🗺️',
    Messages:  '💬',
    Profile:   '👤',
  };
  return <Text style={{ fontSize: 20 }}>{icons[label] || '•'}</Text>;
}

export default function DriverTabs() {
  const { t }           = useTranslation();
  const { unreadCount } = useMessages();
  const insets          = useSafeAreaInsets();
  const c               = useColors();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor:   c.teal600,
        tabBarInactiveTintColor: c.gray400,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.gray300, height: 60 + insets.bottom, paddingBottom: 8 + insets.bottom },
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
      })}>
      <Tab.Screen name="Dashboard" component={DriverDashboardScreen}
        options={{ tabBarLabel: t('nav.dashboard') }} />
      <Tab.Screen name="Available" component={AvailableTripsScreen}
        options={{ tabBarLabel: t('nav.available_trips') }} />
      <Tab.Screen name="MyTrips"   component={DriverMyTripsScreen}
        options={{ tabBarLabel: t('nav.my_trips') }} />
      <Tab.Screen name="Messages"  component={MessagesScreen}
        options={{
          tabBarLabel: t('nav.messages'),
          tabBarBadge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : unreadCount) : undefined,
          tabBarBadgeStyle: { backgroundColor: c.teal600, fontSize: 10 },
        }} />
      <Tab.Screen name="Profile"   component={DriverProfileScreen}
        options={{ tabBarLabel: t('nav.profile') }} />
    </Tab.Navigator>
  );
}
