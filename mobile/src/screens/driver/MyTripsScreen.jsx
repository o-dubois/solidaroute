/**
 * Driver My Trips — shows assigned, completed, and cancelled trips for the driver.
 * Detail parity with the web driver TripDetail component.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { tripService } from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';
import { useAppConfig } from '../../context/AppConfigContext';
import { currencySymbol } from '../../utils/format';

function formatDate(iso, lang = 'fr') {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(min) {
  if (!min) return '—';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${min % 60 > 0 ? ` ${min % 60}min` : ''}`;
}

function calcRoundTripDuration(trip) {
  if (!trip.return_at || !trip.duration_minutes) return null;
  const outbound  = parseInt(trip.duration_minutes);
  const returnDur = outbound;
  const gapMin    = Math.round((new Date(trip.return_at) - new Date(trip.departure_at)) / 60000);
  const waiting   = Math.max(0, gapMin - outbound);
  const total     = gapMin + returnDur;
  return { outbound, waiting, returnDur, total };
}

function canComplete(trip) {
  return trip.status === 'assigned' && new Date(trip.departure_at) <= new Date();
}

export default function DriverMyTripsScreen() {
  const { t, i18n } = useTranslation();
  const { currency } = useAppConfig();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const route = useRoute();
  const [activeTab,   setActiveTab]   = useState(null);
  const [trips,       setTrips]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [completing,  setCompleting]  = useState(null);

  const STATUS_TABS = [
    { key: null,        label: t('driver.status_all') },
    { key: 'upcoming',  label: t('driver.status_assigned') },
    { key: 'completed', label: t('driver.status_completed') },
    { key: 'cancelled', label: t('driver.status_cancelled') },
  ];

  const STATUS_STYLE = {
    pending:   { bg: c.amber50,  text: c.amber700,  label: t('driver.badge_pending')   },
    assigned:  { bg: c.teal100,  text: c.teal700,   label: t('driver.badge_assigned')  },
    completed: { bg: '#f0fdf4',       text: c.green600,  label: t('driver.badge_completed') },
    cancelled: { bg: c.red50,    text: c.red500,    label: t('driver.badge_cancelled') },
  };

  // React to navigation params (e.g. from Dashboard tile tap)
  useEffect(() => {
    const filter = route.params?.filter;
    if (filter) setActiveTab(filter);
  }, [route.params?.filter, route.params?.ts]);

  const loadTrips = useCallback(async () => {
    try {
      const params = activeTab ? { status: activeTab } : {};
      const { data } = await tripService.myTrips(params);
      setTrips(data.trips || []);
    } catch {
      setTrips([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTab]);

  useEffect(() => {
    setLoading(true);
    loadTrips();
  }, [loadTrips]);

  async function handleComplete(tripId) {
    setCompleting(tripId);
    try {
      await tripService.complete(tripId);
      // Optimistic update — no full reload needed
      setTrips(prev => prev.map(tr =>
        tr.id === tripId
          ? { ...tr, status: 'completed', completion_source: 'driver' }
          : tr
      ));
    } catch (err) {
      const code = err?.response?.data?.code;
      Alert.alert(
        t('common.error'),
        code === 'TOO_EARLY' ? t('trips.complete_too_early') : t('common.error')
      );
    } finally {
      setCompleting(null);
    }
  }

  return (
    <SafeAreaView style={sh.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('driver.my_trips_title')}</Text>
      </View>

      {/* Status filter chips */}
      <View style={styles.chipBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipBarContent}>
          {STATUS_TABS.map(tab => (
            <TouchableOpacity
              key={String(tab.key)}
              style={[styles.chip, activeTab === tab.key && styles.chipActive]}
              onPress={() => setActiveTab(tab.key)}>
              <Text style={[styles.chipText, activeTab === tab.key && styles.chipTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <ActivityIndicator color={c.teal600} style={{ marginTop: 60 }} />
      ) : trips.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={{ fontSize: 40 }}>🚗</Text>
          <Text style={styles.emptyTitle}>{t('driver.no_my_trips_title')}</Text>
          <Text style={styles.emptyDesc}>{t('driver.no_my_trips_desc')}</Text>
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={trips}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          refreshControl={
            <RefreshControl refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); loadTrips(); }} />
          }
          renderItem={({ item }) => (
            <TripCard
              trip={item}
              statusStyle={STATUS_STYLE}
              lang={i18n.language}
              onComplete={handleComplete}
              completing={completing}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ── DetailRow ────────────────────────────────────────────────────────────────

function DetailRow({ icon, label, value }) {
  const c = useColors();
  const drStyles = useMemo(() => makeDrStyles(c), [c]);
  return (
    <View style={drStyles.row}>
      <Text style={drStyles.icon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={drStyles.label}>{label}</Text>
        <Text style={drStyles.value}>{value}</Text>
      </View>
    </View>
  );
}

// ── TripCard ─────────────────────────────────────────────────────────────────

function TripCard({ trip, statusStyle = {}, lang = 'fr', onComplete, completing }) {
  const { t }      = useTranslation();
  const c          = useColors();
  const styles     = useMemo(() => makeStyles(c), [c]);
  const { currency } = useAppConfig();
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const s = statusStyle[trip.status] || statusStyle.assigned || { bg: c.teal100, text: c.teal700, label: trip.status };

  const rt       = calcRoundTripDuration(trip);
  const eligible = canComplete(trip);

  const completionLabel = {
    driver:    t('trips.completion_driver'),
    safeguard: t('trips.completion_safeguard'),
    operator:  t('trips.completion_operator'),
  }[trip.completion_source];

  return (
    <TouchableOpacity style={styles.card} onPress={() => setExpanded(e => !e)} activeOpacity={0.85}>
      {/* ── Header ── */}
      <View style={styles.cardHead}>
        <Text style={styles.date}>{formatDate(trip.departure_at, lang)}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={[styles.badge, { backgroundColor: s.bg }]}>
            <Text style={[styles.badgeText, { color: s.text }]}>{s.label}</Text>
          </View>
          <Text style={{ fontSize: 12, color: c.gray400 }}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </View>

      {/* ── Route (always visible) ── */}
      <Text style={styles.routeFrom} numberOfLines={expanded ? 0 : 1}>📍 {trip.pickup_address}</Text>
      <Text style={styles.routeTo}   numberOfLines={expanded ? 0 : 1}>🏁 {trip.dropoff_address}</Text>

      {/* ── Footer (always visible) ── */}
      <View style={styles.cardFoot}>
        <Text style={styles.meta}>
          {trip.client_name ? `🧑 ${trip.client_name}` : ''}
          {trip.client_name ? '  ' : ''}
          👥 {trip.passenger_count} pass.
        </Text>
        {trip.estimated_cost
          ? <Text style={styles.price}>
              {parseFloat(trip.estimated_cost).toFixed(2)} {currencySymbol(trip.currency || currency)}
            </Text>
          : null}
      </View>

      {/* ── Expanded detail ── */}
      {expanded && (
        <View style={styles.detail}>

          {/* Addresses */}
          <DetailRow icon="🟢" label={t('trips.confirm_pickup')}  value={trip.pickup_address} />
          <DetailRow icon="🔴" label={t('trips.confirm_dropoff')} value={trip.dropoff_address} />

          {/* Timing */}
          <DetailRow icon="📅" label={t('trips.confirm_departure')} value={formatDate(trip.departure_at, lang)} />
          {trip.return_at && (
            <DetailRow icon="🔄" label={t('trips.confirm_return')} value={formatDate(trip.return_at, lang)} />
          )}

          {/* Passengers + trip type */}
          <DetailRow icon="👥" label={t('trips.confirm_passengers')}
            value={t('trips.passengers', { count: trip.passenger_count })} />
          <View style={styles.tripTypeBadgeWrap}>
            <Text style={[styles.tripTypeBadgeText,
              trip.return_at ? styles.tripTypeBadgeRound : styles.tripTypeBadgeOneWay]}>
              {trip.return_at ? `🔄 ${t('trips.round_trip')}` : `➡️ ${t('trips.one_way')}`}
            </Text>
          </View>

          {/* Distance & duration */}
          {trip.distance_km && (
            <DetailRow icon="🛣️" label={t('trips.distance')} value={`${trip.distance_km} km`} />
          )}
          {trip.duration_minutes && (
            <DetailRow icon="⏱️" label={t('trips.duration_outbound')}
              value={formatDuration(parseInt(trip.duration_minutes))} />
          )}
          {rt && (
            <>
              <DetailRow icon="⏱️" label={t('trips.duration_return')}
                value={formatDuration(rt.returnDur)} />
              <View style={styles.totalServiceBox}>
                <Text style={styles.totalServiceTitle}>
                  🕐 {t('trips.duration_total_service')}
                </Text>
                <Text style={styles.totalServiceValue}>{formatDuration(rt.total)}</Text>
                <Text style={styles.totalServiceBreakdown}>
                  {t('trips.duration_breakdown', {
                    outbound: formatDuration(rt.outbound),
                    waiting:  formatDuration(rt.waiting),
                    ret:      formatDuration(rt.returnDur),
                  })}
                </Text>
              </View>
            </>
          )}

          {/* Cost */}
          {trip.estimated_cost && trip.status !== 'cancelled' && (
            <DetailRow icon="💰" label={t('trips.estimated_cost')}
              value={`${parseFloat(trip.estimated_cost).toFixed(2)} ${currencySymbol(trip.payment_currency || currency)}`} />
          )}

          {/* Client */}
          {trip.client_name && (
            <DetailRow icon="🧑" label={t('trips.client_label')} value={trip.client_name} />
          )}
          {trip.client_phone && (
            <DetailRow icon="📞" label={t('trips.client_phone')} value={trip.client_phone} />
          )}
          {trip.booked_by_name && (
            <DetailRow icon="📋" label={t('trips.booked_by')} value={trip.booked_by_name} />
          )}

          {/* Client notes — amber highlight like web */}
          {trip.client_notes && (
            <View style={styles.notesBox}>
              <Text style={styles.notesLabel}>💬 {t('trips.client_notes_label')}</Text>
              <Text style={styles.notesText}>{trip.client_notes}</Text>
            </View>
          )}

          {/* Completion source */}
          {trip.completion_source && completionLabel && (
            <View style={styles.completionRow}>
              <Text style={styles.completionLabel}>🏁 {t('trips.completion_source')}</Text>
              <View style={[styles.completionBadge,
                trip.completion_source === 'driver'    ? styles.completionDriver :
                trip.completion_source === 'safeguard' ? styles.completionSafeguard :
                                                         styles.completionOperator]}>
                <Text style={[styles.completionBadgeText,
                  trip.completion_source === 'driver'    ? { color: c.teal700 } :
                  trip.completion_source === 'safeguard' ? { color: '#c2410c' } :
                                                           { color: '#7e22ce' }]}>
                  {completionLabel}
                </Text>
              </View>
            </View>
          )}

          {/* Trip number */}
          {trip.trip_number && (
            <Text style={styles.tripNumberLabel}>T-{trip.trip_number}</Text>
          )}

          {/* Action buttons */}
          <View style={styles.actionRow}>
            {trip.client_id && (
              <TouchableOpacity
                style={styles.actionBtn}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('Messages', {
                  tripId:     trip.id,
                  tripNumber: trip.trip_number,
                  otherName:  trip.client_name || t('messages.unknown_client'),
                  ts: Date.now(),
                })}
              >
                <Text style={styles.actionBtnText}>💬 {t('messages.open_chat')}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Complete button — shown only when departure has passed */}
          {eligible && (
            <TouchableOpacity
              style={[styles.completeBtn, completing === trip.id && styles.completeBtnDisabled]}
              onPress={() => onComplete(trip.id)}
              disabled={completing === trip.id}
              activeOpacity={0.8}
            >
              {completing === trip.id
                ? <ActivityIndicator color={c.white} size="small" />
                : <Text style={styles.completeBtnText}>{t('trips.complete_btn')}</Text>
              }
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function makeDrStyles(c) {
  return StyleSheet.create({
    row:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 6 },
    icon:  { fontSize: 14, marginTop: 2, width: 20, textAlign: 'center' },
    label: { fontSize: 10, color: c.teal700, marginBottom: 1 },
    value: { fontSize: 13, color: c.gray800, fontWeight: '500' },
  });
}

function makeStyles(c) {
  return StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.gray200,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.gray900 },

  chipBar: {
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.gray100,
    height: 52,
  },
  chipBarContent: {
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, alignItems: 'center',
  },
  chip: {
    paddingHorizontal: spacing.md, paddingVertical: 6, marginRight: spacing.sm,
    borderRadius: radius.full, borderWidth: 1, borderColor: c.gray300,
  },
  chipActive:     { backgroundColor: c.teal600, borderColor: c.teal600 },
  chipText:       { fontSize: 12, color: c.gray600 },
  chipTextActive: { color: c.white, fontWeight: '600' },

  emptyBox: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: c.gray700, marginTop: spacing.md },
  emptyDesc:  { fontSize: 13, color: c.gray400, textAlign: 'center', marginTop: spacing.sm },

  card: {
    backgroundColor: c.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm,
    elevation: 1, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3,
  },
  cardHead:  { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  date:      { fontSize: 12, color: c.gray500 },
  badge:     { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
  badgeText: { fontSize: 11, fontWeight: '600' },
  routeFrom: { fontSize: 13, color: c.gray800, fontWeight: '500', marginBottom: 2 },
  routeTo:   { fontSize: 13, color: c.gray800 },
  cardFoot:  { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  meta:      { fontSize: 12, color: c.gray500 },
  price:     { fontSize: 13, fontWeight: '600', color: c.teal700 },

  detail: {
    marginTop: spacing.sm, paddingTop: spacing.sm,
    borderTopWidth: 1, borderTopColor: c.gray100, gap: 4,
  },

  tripTypeBadgeWrap: { marginBottom: 6 },
  tripTypeBadgeText: {
    fontSize: 11, fontWeight: '600', alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, overflow: 'hidden',
  },
  tripTypeBadgeOneWay: { backgroundColor: '#eff6ff', color: '#1d4ed8' },
  tripTypeBadgeRound:  { backgroundColor: '#faf5ff', color: '#7e22ce' },

  totalServiceBox: {
    marginBottom: 6, backgroundColor: '#faf5ff',
    borderWidth: 1, borderColor: '#e9d5ff',
    borderRadius: radius.md, padding: spacing.sm,
  },
  totalServiceTitle:     { fontSize: 10, color: '#7e22ce', fontWeight: '600', marginBottom: 2 },
  totalServiceValue:     { fontSize: 14, fontWeight: '700', color: '#581c87' },
  totalServiceBreakdown: { fontSize: 10, color: '#a855f7', marginTop: 2 },

  notesBox: {
    marginBottom: 6, backgroundColor: c.amber50,
    borderWidth: 1, borderColor: '#fde68a',
    borderRadius: radius.md, padding: spacing.sm,
  },
  notesLabel: { fontSize: 11, color: c.amber700, fontWeight: '600', marginBottom: 2 },
  notesText:  { fontSize: 12, color: '#92400e' },

  completionRow:  { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 6 },
  completionLabel: { fontSize: 11, color: c.gray500 },
  completionBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
  completionBadgeText: { fontSize: 11, fontWeight: '600' },
  completionDriver:    { backgroundColor: c.teal100 },
  completionSafeguard: { backgroundColor: '#ffedd5' },
  completionOperator:  { backgroundColor: '#f3e8ff' },

  tripNumberLabel: { fontSize: 11, color: c.gray400, marginBottom: 4 },

  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  actionBtn: {
    alignSelf: 'flex-start', backgroundColor: c.teal100,
    borderRadius: radius.md, paddingVertical: 6, paddingHorizontal: spacing.md,
  },
  actionBtnText: { fontSize: 13, color: c.teal700, fontWeight: '600' },

  completeBtn: {
    marginTop: spacing.sm, backgroundColor: c.green600,
    borderRadius: radius.md, paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  completeBtnDisabled: { opacity: 0.6 },
  completeBtnText: { fontSize: 14, color: c.white, fontWeight: '700' },
  });
}
