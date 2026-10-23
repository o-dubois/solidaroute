/**
 * Driver Dashboard
 * Shows approval status, on/off duty toggle, and trip stats.
 * Stat tiles navigate to the relevant tab.
 */
import { useEffect, useState , useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Switch, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useAuth }       from '../../context/AuthContext';
import { useAppConfig }  from '../../context/AppConfigContext';
import { tripService, driverService } from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';

export default function DriverDashboardScreen() {
  const { t }       = useTranslation();
  const { user, refreshUser } = useAuth();
  const { appName, webAppUrl } = useAppConfig();
  const navigation  = useNavigation();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [stats,    setStats]    = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [toggling, setToggling] = useState(false);

  const isAvailable = user?.profile?.is_available ?? false;
  const isApproved  = user?.profile?.approval_status === 'approved';

  useEffect(() => {
    tripService.stats()
      .then(({ data }) => setStats(data.stats))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleToggle() {
    setToggling(true);
    try {
      await driverService.setAvailability({ is_available: !isAvailable });
      await refreshUser();
    } catch {
      // silently ignore — toggle snaps back on next render
    } finally { setToggling(false); }
  }

  return (
    <SafeAreaView style={sh.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.greeting}>
            {t('auth.welcome', { name: user?.first_name })}
          </Text>
          <Text style={styles.subGreeting}>{appName}</Text>
        </View>

        {/* Status card */}
        <View style={sh.card}>
          <View style={styles.statusRow}>
            <Text style={styles.statusIcon}>{isApproved ? '✅' : '⏳'}</Text>
            <Text style={styles.statusLabel}>
              {isApproved ? t('driver.approved_by', { appName }) : t('driver.pending_approval')}
            </Text>
          </View>

          {isApproved && (
            <View style={[styles.statusRow, { marginTop: spacing.md }]}>
              <Text style={styles.statusIcon}>{isAvailable ? '🟢' : '🔴'}</Text>
              <Text style={[styles.statusLabel, { flex: 1 }]}>
                {isAvailable ? t('dashboard.on_duty') : t('dashboard.off_duty')}
              </Text>
              {toggling
                ? <ActivityIndicator color={c.teal600} />
                : <Switch
                    value={isAvailable}
                    onValueChange={handleToggle}
                    trackColor={{ false: c.gray300, true: c.teal500 }}
                    thumbColor={isAvailable ? c.teal600 : c.gray400}
                  />
              }
            </View>
          )}
        </View>

        {/* Stat tiles */}
        {loading ? (
          <ActivityIndicator color={c.teal600} style={{ marginTop: 32 }} />
        ) : (
          <View style={styles.statsRow}>
            <StatTile icon="📍" label={t('dashboard.available')}
              value={stats?.available_trips ?? 0}
              onPress={() => navigation.navigate('Available')} />
            <StatTile icon="✅" label={t('dashboard.completed')}
              value={stats?.completed ?? 0}
              onPress={() => navigation.navigate('MyTrips', { filter: 'completed', ts: Date.now() })} />
            <StatTile icon="💰" label={t('dashboard.earnings')}
              value={`$${parseFloat(stats?.earnings?.pending_earnings ?? 0).toFixed(0)}`}
              onPress={() => navigation.navigate('MyTrips', { filter: 'completed', ts: Date.now() })} />
          </View>
        )}

        {/* Web-only features banner */}
        <View style={styles.webBanner}>
          <Text style={styles.webBannerTitle}>🌐 {t('dashboard.web_only_title')}</Text>
          <Text style={styles.webBannerFeatures}>{t('dashboard.web_only_driver')}</Text>
          <Text style={styles.webBannerFuture}>{t('dashboard.web_only_future')}</Text>
          {!!webAppUrl && (
            <TouchableOpacity onPress={() => Linking.openURL(webAppUrl)}>
              <Text style={styles.webBannerLink}>{t('dashboard.web_only_link')}</Text>
            </TouchableOpacity>
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

function StatTile({ icon, label, value, onPress }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <TouchableOpacity style={styles.statTile} onPress={onPress} activeOpacity={0.7}>
      <Text style={{ fontSize: 22 }}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function makeStyles(c) {
  return StyleSheet.create({
    scroll:      { padding: spacing.lg, paddingBottom: 40 },
    header:      { marginBottom: spacing.xl },
    greeting:    { fontSize: 20, fontWeight: '700', color: c.gray900 },
    subGreeting: { fontSize: 13, color: c.gray500, marginTop: 2 },
    statusRow:   { flexDirection: 'row', alignItems: 'center' },
    statusIcon:  { fontSize: 20, marginRight: spacing.md },
    statusLabel: { fontSize: 14, color: c.gray700, fontWeight: '500' },
    statsRow:    { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, marginBottom: spacing.lg },
    statTile: {
      flex: 1, backgroundColor: c.surface, borderRadius: radius.lg,
      padding: spacing.md, alignItems: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05, shadowRadius: 3, elevation: 1,
    },
    statValue: { fontSize: 20, fontWeight: '700', color: c.gray900, marginTop: 4 },
    statLabel: { fontSize: 11, color: c.gray500, marginTop: 2, textAlign: 'center' },
    webBanner: {
      backgroundColor: c.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: c.teal200,
      padding: spacing.md, marginBottom: spacing.lg,
    },
    webBannerTitle:    { fontSize: 13, fontWeight: '700', color: c.teal700, marginBottom: 4 },
    webBannerFeatures: { fontSize: 12, color: c.gray600, marginBottom: 2 },
    webBannerFuture:   { fontSize: 11, color: c.gray400, fontStyle: 'italic', marginBottom: 4 },
    webBannerLink:     { fontSize: 12, color: c.teal600, fontWeight: '600', marginTop: 2 },
  });
}
