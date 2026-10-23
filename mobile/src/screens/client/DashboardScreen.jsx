/**
 * Client Dashboard
 * Shows greeting + trip stats. Each tile navigates to the Trips tab
 * with the corresponding status filter pre-selected.
 */
import { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useAuth }      from '../../context/AuthContext';
import { useAppConfig } from '../../context/AppConfigContext';
import { tripService }  from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';

export default function ClientDashboardScreen() {
  const { t }            = useTranslation();
  const { user } = useAuth();
  const { appName, webAppUrl } = useAppConfig();
  const navigation       = useNavigation();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [stats,   setStats]   = useState(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      tripService.stats()
        .then(({ data }) => setStats(data.stats))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, [])
  );

  function goTrips(filter) {
    navigation.navigate('Trips', { filter, ts: Date.now() });
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

        {loading ? (
          <ActivityIndicator color={c.teal600} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Stat tiles — tap to open filtered trip list */}
            <View style={styles.statsRow}>
              <StatTile icon="🗺️" label={t('dashboard.upcoming')}
                value={stats?.upcoming ?? 0}
                onPress={() => goTrips('upcoming')} />
              <StatTile icon="✅" label={t('dashboard.completed')}
                value={stats?.completed ?? 0}
                onPress={() => goTrips('completed')} />
              <StatTile icon="❌" label={t('dashboard.cancelled')}
                value={stats?.cancelled ?? 0}
                onPress={() => goTrips('cancelled')} />
            </View>

            {/* Web-only features banner */}
            <View style={styles.webBanner}>
              <Text style={styles.webBannerTitle}>🌐 {t('dashboard.web_only_title')}</Text>
              <Text style={styles.webBannerFeatures}>{t('dashboard.web_only_client')}</Text>
              <Text style={styles.webBannerFuture}>{t('dashboard.web_only_future')}</Text>
              {!!webAppUrl && (
                <TouchableOpacity onPress={() => Linking.openURL(webAppUrl)}>
                  <Text style={styles.webBannerLink}>{t('dashboard.web_only_link')}</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Book a trip CTA */}
            <TouchableOpacity style={styles.bookCard} onPress={() => goTrips('book')}>
              <Text style={styles.bookCardIcon}>🚗</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.bookCardTitle}>{t('dashboard.book_title')}</Text>
                <Text style={styles.bookCardDesc}>{t('dashboard.book_desc')}</Text>
              </View>
              <Text style={styles.bookCardArrow}>→</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatTile({ icon, label, value, onPress }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <TouchableOpacity style={styles.statTile} onPress={onPress} activeOpacity={0.7}>
      <Text style={{ fontSize: 24 }}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function makeStyles(c) {
  return StyleSheet.create({
    scroll: { padding: spacing.lg, paddingBottom: 40 },
    header: { marginBottom: spacing.xl },
    greeting:    { fontSize: 20, fontWeight: '700', color: c.gray900 },
    subGreeting: { fontSize: 13, color: c.gray500, marginTop: 2 },
    statsRow:    { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
    statTile: {
      flex: 1, backgroundColor: c.surface, borderRadius: radius.lg,
      padding: spacing.md, alignItems: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05, shadowRadius: 3, elevation: 1,
    },
    statValue: { fontSize: 22, fontWeight: '700', color: c.gray900, marginTop: 4 },
    statLabel: { fontSize: 11, color: c.gray500, marginTop: 2, textAlign: 'center' },
    bookCard: {
      flexDirection: 'row', alignItems: 'center', backgroundColor: c.teal600,
      borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md,
    },
    bookCardIcon:  { fontSize: 28 },
    bookCardTitle: { fontSize: 15, fontWeight: '700', color: '#ffffff' },
    bookCardDesc:  { fontSize: 12, color: c.teal100, marginTop: 2 },
    bookCardArrow: { fontSize: 20, color: '#ffffff', fontWeight: '700' },
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
