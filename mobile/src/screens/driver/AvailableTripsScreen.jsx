/**
 * Driver Available Trips — Phase 2
 * Shows preferred trips (where this driver was personally chosen) at the top,
 * then general pending trips within the configured radius.
 * Pull-to-refresh supported. Accept/decline with confirmation alert.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { tripService } from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';
import { useAppConfig } from '../../context/AppConfigContext';
import { currencySymbol } from '../../utils/format';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso, lang = 'fr') {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function AvailableTripsScreen() {
  const { t, i18n } = useTranslation();
  const { currency } = useAppConfig();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [result,     setResult]     = useState({ preferred_trips: [], trips: [] });
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting,     setActing]     = useState(null); // trip id currently being acted on

  const load = useCallback(async () => {
    try {
      const { data } = await tripService.available();
      setResult(data);
    } catch {
      // keep empty state — empty-list UI handles it
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAccept(id) {
    setActing(id);
    try {
      await tripService.accept(id);
      await load();
    } catch (e) {
      Alert.alert(t('common.error'), e.response?.data?.error || t('driver.err_accept'));
    } finally {
      setActing(null);
    }
  }

  function confirmDecline(id) {
    Alert.alert(
      t('driver.decline_title'),
      t('driver.decline_confirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('driver.btn_decline'), style: 'destructive',
          onPress: async () => {
            setActing(id);
            try {
              await tripService.decline(id);
              await load();
            } catch (e) {
              Alert.alert(t('common.error'), e.response?.data?.error || t('driver.err_decline'));
            } finally {
              setActing(null);
            }
          },
        },
      ],
    );
  }

  const noTrips = result.preferred_trips.length === 0 && result.trips.length === 0;

  return (
    <SafeAreaView style={sh.screen}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('driver.available_title')}</Text>
        {result.base_radius_km
          ? <Text style={styles.headerSub}>{t('driver.radius_label', { km: result.base_radius_km })}</Text>
          : null}
      </View>

      {loading ? (
        <ActivityIndicator color={c.teal600} style={{ marginTop: 60 }} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }} />
          }>

          {noTrips && (
            <View style={styles.emptyBox}>
              <Text style={{ fontSize: 40 }}>📍</Text>
              <Text style={styles.emptyTitle}>{t('driver.no_trips_title')}</Text>
              <Text style={styles.emptyDesc}>{t('driver.no_trips_desc')}</Text>
            </View>
          )}

          {/* Preferred trips */}
          {result.preferred_trips.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>{t('driver.preferred_section')}</Text>
              {result.preferred_trips.map(trip => (
                <TripCard
                  key={trip.id}
                  trip={trip}
                  preferred
                  acting={acting === trip.id}
                  onAccept={() => handleAccept(trip.id)}
                  onDecline={() => confirmDecline(trip.id)}
                  lang={i18n.language}
                />
              ))}
            </>
          )}

          {/* Nearby trips */}
          {result.trips.length > 0 && (
            <>
              <Text style={[styles.sectionTitle,
                result.preferred_trips.length > 0 && { marginTop: spacing.lg }]}>
                {t('driver.nearby_section')}
              </Text>
              {result.trips.map(trip => (
                <TripCard
                  key={trip.id}
                  trip={trip}
                  acting={acting === trip.id}
                  onAccept={() => handleAccept(trip.id)}
                  onDecline={() => confirmDecline(trip.id)}
                  lang={i18n.language}
                />
              ))}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── TripCard ───────────────────────────────────────────────────────────────────

function TripCard({ trip, preferred, acting, onAccept, onDecline, lang = 'fr' }) {
  const { t } = useTranslation();
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { currency } = useAppConfig();
  const alreadyDeclined = trip.driver_action === 'declined';

  return (
    <View style={[
      styles.card,
      preferred      && styles.cardPreferred,
      alreadyDeclined && styles.cardDimmed,
    ]}>
      {preferred && (
        <View style={styles.preferredTag}>
          <Text style={styles.preferredTagText}>{t('driver.preferred_badge')}</Text>
        </View>
      )}
      {alreadyDeclined && (
        <View style={styles.declinedTag}>
          <Text style={styles.declinedTagText}>{t('driver.declined_badge')}</Text>
        </View>
      )}

      <Text style={styles.dateText}>{formatDate(trip.departure_at, lang)}</Text>

      <View style={styles.routeBlock}>
        <Text style={styles.routeFrom} numberOfLines={2}>📍 {trip.pickup_address}</Text>
        <Text style={styles.routeArrow}>↓</Text>
        <Text style={styles.routeTo}   numberOfLines={2}>🏁 {trip.dropoff_address}</Text>
      </View>

      {/* Meta chips */}
      <View style={styles.chips}>
        {trip.client_name && (
          <Chip icon="🧑" value={trip.client_name} />
        )}
        <Chip icon="👥" value={`${trip.passenger_count} pass.`} />
        {trip.distance_from_home_km != null && (
          <Chip icon="📏" value={`${trip.distance_from_home_km} km`} />
        )}
        {trip.estimated_cost && (
          <Chip icon="💰"
            value={`${parseFloat(trip.estimated_cost).toFixed(2)} ${currencySymbol(trip.currency || currency)}`} />
        )}
      </View>

      {/* Accept / Decline */}
      {!alreadyDeclined && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btnAccept, acting && styles.btnDisabled]}
            onPress={onAccept}
            disabled={!!acting}>
            {acting
              ? <ActivityIndicator color={c.white} size="small" />
              : <Text style={styles.btnAcceptText}>{t('driver.btn_accept')}</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnDecline, acting && styles.btnDisabled]}
            onPress={onDecline}
            disabled={!!acting}>
            <Text style={styles.btnDeclineText}>{t('driver.btn_decline')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function Chip({ icon, value }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.gray100, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 }}>
      <Text style={{ fontSize: 11, color: c.gray700 }}>{icon} {value}</Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

function makeStyles(c) {
  return StyleSheet.create({
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.gray200,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.gray900 },
  headerSub:   { fontSize: 12, color: c.gray500 },

  emptyBox: {
    alignItems: 'center', marginTop: 60, padding: spacing.xl,
  },
  emptyTitle: {
    fontSize: 16, fontWeight: '600', color: c.gray700, marginTop: spacing.md,
  },
  emptyDesc: {
    fontSize: 13, color: c.gray400, textAlign: 'center',
    marginTop: spacing.sm, lineHeight: 20,
  },

  sectionTitle: {
    fontSize: 14, fontWeight: '600', color: c.gray700, marginBottom: spacing.sm,
  },

  card: {
    backgroundColor: c.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm,
    elevation: 2, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 4,
  },
  cardPreferred: { borderWidth: 2, borderColor: c.teal600 },
  cardDimmed:    { opacity: 0.55 },

  preferredTag: {
    backgroundColor: c.teal600, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    alignSelf: 'flex-start', marginBottom: spacing.sm,
  },
  preferredTagText: { color: c.white, fontSize: 11, fontWeight: '700' },

  declinedTag: {
    backgroundColor: c.red50, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    alignSelf: 'flex-start', marginBottom: spacing.sm,
  },
  declinedTagText: { color: c.red500, fontSize: 11, fontWeight: '600' },

  dateText: { fontSize: 12, color: c.gray500, marginBottom: spacing.sm },

  routeBlock: { marginBottom: spacing.sm },
  routeFrom:  { fontSize: 13, color: c.gray800, fontWeight: '500' },
  routeArrow: { fontSize: 12, color: c.gray400, marginLeft: spacing.sm, marginVertical: 2 },
  routeTo:    { fontSize: 13, color: c.gray800 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    backgroundColor: c.gray100, borderRadius: radius.full,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
  },
  chipText: { fontSize: 11, color: c.gray700 },

  actions:     { flexDirection: 'row', gap: spacing.sm },
  btnAccept: {
    flex: 1, backgroundColor: c.teal600,
    borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center',
  },
  btnAcceptText: { color: c.white, fontWeight: '600', fontSize: 13 },
  btnDecline: {
    flex: 1, backgroundColor: c.surface,
    borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center',
    borderWidth: 1, borderColor: c.red500,
  },
  btnDeclineText: { color: c.red500, fontWeight: '600', fontSize: 13 },
  btnDisabled:    { opacity: 0.5 },
  });
}
