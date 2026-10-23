/**
 * Client Trips — Phase 2
 *
 * List view  — trip list with status filter tabs, pull-to-refresh.
 * Book view  — 5-step wizard:
 *   Step 1: Pickup + dropoff addresses (with autocomplete) + passenger count
 *   Step 2: Date & time (+ optional return) → fetches estimate
 *   Step 3: Driver selection (nearby + search + skip)
 *   Step 4: Summary + notes + confirm → creates trip
 *   Step 5: Payment (Stripe setup-intent | mobility ticket reservation | manual)
 *   Step 6: Success screen
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, FlatList, TouchableOpacity,
  TextInput, Switch, StyleSheet, ActivityIndicator,
  RefreshControl, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { CardField, useStripe } from '@stripe/stripe-react-native';
import { tripService, driverService, ticketService, paymentService } from '../../services/api';
import { useAppConfig } from '../../context/AppConfigContext';
import { currencySymbol } from '../../utils/format';
import { useTranslation } from 'react-i18next';
import { useColors, useShared, spacing, radius } from '../../theme';

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function parseDate(dateStr, timeStr) {
  const dm = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = timeStr.trim().match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const d = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  return isNaN(d.getTime()) ? null : d;
}

const EMPTY_ADDR = { address: '', lat: null, lon: null };
const EMPTY_FORM = {
  pickup:     { ...EMPTY_ADDR },
  dropoff:    { ...EMPTY_ADDR },
  passengers: '1',
  date:       '',
  time:       '',
  hasReturn:  false,
  retDate:    '',
  retTime:    '',
  notes:      '',
};

// ── Address autocomplete input ─────────────────────────────────────────────────

function AddressInput({ value, onSelect, placeholder, label }) {
  const { t }                       = useTranslation();
  const c      = useColors();
  const sh     = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [query,    setQuery]        = useState(value?.address || '');
  const [results,  setResults]      = useState([]);
  const [fetching, setFetching]     = useState(false);
  const [recents,    setRecents]    = useState([]);
  // hasFocused is a one-way flag: true once the field has been focused, never
  // reset to false. This prevents the blur-before-press race condition where
  // onBlur fires and hides the dropdown before onPress can register on a item.
  const [hasFocused, setHasFocused] = useState(false);
  const timer = useRef(null);

  useEffect(() => { setQuery(value?.address || ''); }, [value?.address]);

  // Fetch recent addresses once on mount
  useEffect(() => {
    tripService.recentAddresses()
      .then(({ data }) => setRecents(data.results || []))
      .catch(() => {});
  }, []);

  function handleChange(text) {
    setQuery(text);
    onSelect({ address: text, lat: null, lon: null });
    if (timer.current) clearTimeout(timer.current);
    if (text.length < 3) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setFetching(true);
      try {
        const { data } = await tripService.addressSearch(text);
        setResults(data.results || []);
      } catch {
        setResults([]);
      } finally {
        setFetching(false);
      }
    }, 350);
  }

  function pick(item) {
    setQuery(item.label);
    setResults([]);
    onSelect({ address: item.label, lat: item.lat, lon: item.lon });
  }

  const showRecents = hasFocused && query.length < 3 && recents.length > 0 && results.length === 0;

  return (
    <View style={{ marginBottom: spacing.sm }}>
      {label && <Text style={sh.label}>{label}</Text>}
      <View style={{ position: 'relative' }}>
        <TextInput
          style={sh.input}
          value={query}
          onChangeText={handleChange}
          onFocus={() => setHasFocused(true)}
          placeholder={placeholder}
          placeholderTextColor={c.gray400}
          autoCorrect={false}
        />
        {fetching && (
          <ActivityIndicator size="small" color={c.teal600}
            style={{ position: 'absolute', right: 10, top: 10 }} />
        )}
      </View>
      {showRecents && (
        <ScrollView
          style={styles.dropdown}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          scrollEnabled={false}
        >
          <Text style={styles.dropdownSectionLabel}>{t('booking.recent_addresses')}</Text>
          {recents.map((item, i) => (
            <TouchableOpacity key={`recent-${i}`}
              style={[styles.dropdownItem, i < recents.length - 1 && styles.dropdownDivider]}
              onPress={() => pick(item)}>
              <Text style={styles.dropdownRecentIcon}>🕐</Text>
              <Text style={[styles.dropdownText, { flex: 1 }]} numberOfLines={2}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      {results.length > 0 && (
        <ScrollView
          style={styles.dropdown}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          scrollEnabled={false}
        >
          {results.map((item, i) => (
            <TouchableOpacity key={item.place_id || i}
              style={[styles.dropdownItem, i < results.length - 1 && styles.dropdownDivider]}
              onPress={() => pick(item)}>
              <Text style={styles.dropdownText} numberOfLines={2}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ── Step indicator ─────────────────────────────────────────────────────────────

function StepBar({ step }) {
  const { t } = useTranslation();
  const c      = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const steps = [
    t('booking.step_addresses'),
    t('booking.step_schedule'),
    t('booking.step_driver'),
    t('booking.step_confirm'),
    t('booking.step_payment'),
  ];
  return (
    <View style={styles.stepBar}>
      {steps.map((label, i) => {
        const n      = i + 1;
        const done   = n < step;
        const active = n === step;
        return (
          <View key={n} style={styles.stepItem}>
            <View style={[styles.stepDot,
              done   && styles.stepDotDone,
              active && styles.stepDotActive]}>
              <Text style={[styles.stepDotText, (done || active) && { color: c.white }]}>
                {done ? '✓' : n}
              </Text>
            </View>
            <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>{label}</Text>
            {i < steps.length - 1 && (
              <View style={[styles.stepLine, done && styles.stepLineDone]} />
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function ClientTripsScreen() {
  const { t, i18n } = useTranslation();
  const route = useRoute();
  const { paymentProvider, currency } = useAppConfig();
  const c      = useColors();
  const sh     = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);

  // Translated constants (re-computed when language changes)
  const STATUS_TABS = [
    { key: null,        label: t('trips.status_all') },
    { key: 'pending',   label: t('trips.status_pending') },
    { key: 'upcoming',  label: t('trips.status_upcoming') },
    { key: 'completed', label: t('trips.status_completed') },
    { key: 'cancelled', label: t('trips.status_cancelled') },
  ];
  const STATUS_STYLE = {
    pending:   { bg: c.amber50,  text: c.amber700,  label: t('trips.badge_pending')   },
    assigned:  { bg: c.teal100,  text: c.teal700,   label: t('trips.badge_assigned')  },
    completed: { bg: '#f0fdf4',       text: c.green600,  label: t('trips.badge_completed') },
    cancelled: { bg: c.red50,    text: c.red500,    label: t('trips.badge_cancelled') },
  };

  const [view, setView] = useState('list'); // 'list' | 'book'

  // ── List state ───────────────────────────────────────────────────────────────
  const [activeTab,   setActiveTab]   = useState(null);
  const [trips,       setTrips]       = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);

  // ── Wizard state ─────────────────────────────────────────────────────────────
  const [step,       setStep]       = useState(1);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [estimate,   setEstimate]   = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [booking,    setBooking]    = useState(false);
  const [bookError,  setBookError]  = useState('');
  const [tripId,     setTripId]     = useState(null);

  // ── Step 3: driver selection ─────────────────────────────────────────────────
  const [selectedDriver,    setSelectedDriver]    = useState(null);
  const [nearbyDrivers,     setNearbyDrivers]     = useState([]);
  const [driverSearchQuery, setDriverSearchQuery] = useState('');
  const [driverResults,     setDriverResults]     = useState([]);
  const [driverLoading,     setDriverLoading]     = useState(false);
  const [driverAvailMsg,    setDriverAvailMsg]    = useState('');
  const driverTimer = useRef(null);

  // ── Step 5: payment ──────────────────────────────────────────────────────────
  const [paymentMethod,   setPaymentMethod]   = useState(null);  // 'card'|'mobility'|'manual' — null = use paymentProvider default
  const [ticketInfo,      setTicketInfo]      = useState(null);  // { required_count, facial_value, currency, available_tickets }
  const [ticketInput,     setTicketInput]     = useState('');    // comma-separated ticket numbers
  const [paymentLoading,  setPaymentLoading]  = useState(false);
  const [paymentError,    setPaymentError]    = useState('');
  const [paymentDone,     setPaymentDone]     = useState(false);
  const [stripeInitiated, setStripeInitiated] = useState(false);
  const [clientSecret,    setClientSecret]    = useState('');    // Stripe SetupIntent client secret
  const [stripePaymentId, setStripePaymentId] = useState(null);  // our internal payments.id

  // Resolve the effective payment method for display
  const effectiveMethod = paymentMethod ?? (paymentProvider === 'mobility' ? 'mobility' : 'card');

  // ── React to navigation params from Dashboard ────────────────────────────────

  useEffect(() => {
    const filter = route.params?.filter;
    if (filter === 'book') {
      resetBook();
      setView('book');
    } else if (filter) {
      setActiveTab(filter);
      setView('list');
    }
  }, [route.params?.filter, route.params?.ts]);

  // ── Load trip list ───────────────────────────────────────────────────────────

  const loadTrips = useCallback(async () => {
    try {
      const params = activeTab ? { status: activeTab } : {};
      const { data } = await tripService.myTrips(params);
      setTrips(data.trips || []);
    } catch {
      setTrips([]);
    } finally {
      setListLoading(false);
      setRefreshing(false);
    }
  }, [activeTab]);

  useEffect(() => {
    setListLoading(true);
    loadTrips();
  }, [loadTrips]);

  // ── Step 3: load nearby drivers when step becomes 3 ─────────────────────────

  useEffect(() => {
    if (step !== 3) return;
    const lat = estimate?.pickup?.lat;
    const lon = estimate?.pickup?.lon;
    if (!lat || !lon) return;
    setDriverLoading(true);
    driverService.nearby(lat, lon)
      .then(({ data }) => setNearbyDrivers(data.drivers || []))
      .catch(() => setNearbyDrivers([]))
      .finally(() => setDriverLoading(false));
  }, [step]);

  // ── Step 3: driver name search (debounced 400ms) ─────────────────────────────

  useEffect(() => {
    if (driverSearchQuery.length < 2) { setDriverResults([]); return; }
    if (driverTimer.current) clearTimeout(driverTimer.current);
    driverTimer.current = setTimeout(async () => {
      const lat = estimate?.pickup?.lat;
      const lon = estimate?.pickup?.lon;
      try {
        const { data } = await driverService.search(driverSearchQuery, lat, lon);
        setDriverResults(data.drivers || []);
      } catch {
        setDriverResults([]);
      }
    }, 400);
  }, [driverSearchQuery]);

  // ── Step 5: load ticket info / stripe intent when step is reached ────────────

  useEffect(() => {
    if (step !== 5 || !tripId) return;
    // Always fetch ticket info so the mobility option can show available count
    ticketService.forTrip(tripId)
      .then(({ data }) => {
        setTicketInfo(data);
        if (data.available_tickets?.length >= data.required_count) {
          const nums = data.available_tickets
            .slice(0, data.required_count)
            .map(tk => tk.ticket_number)
            .join(', ');
          setTicketInput(nums);
        }
      })
      .catch(() => {}); // no tickets is fine

    // Register Stripe setup intent if card method is selected
    if (effectiveMethod === 'card' && !stripeInitiated) {
      paymentService.setupIntent({ trip_id: tripId })
        .then(({ data }) => {
          setClientSecret(data.client_secret || '');
          setStripePaymentId(data.payment_id || null);
          setStripeInitiated(true);
        })
        .catch((e) => {
          const msg = e?.response?.data?.error;
          setPaymentError(msg || 'payment.err_stripe_no_key');
        });
    }
  }, [step, tripId]);

  // ── Booking helpers ──────────────────────────────────────────────────────────

  function resetBook() {
    setStep(1);
    setForm(EMPTY_FORM);
    setEstimate(null);
    setBookError('');
    setSelectedDriver(null);
    setNearbyDrivers([]);
    setDriverSearchQuery('');
    setDriverResults([]);
    setDriverAvailMsg('');
    setTripId(null);
    setPaymentMethod(null);
    setTicketInfo(null);
    setTicketInput('');
    setPaymentError('');
    setPaymentDone(false);
    setStripeInitiated(false);
    setClientSecret('');
    setStripePaymentId(null);
  }

  function goBook() { resetBook(); setView('book'); }
  function goList() { setView('list'); }

  function handleRebook(trip) {
    resetBook();
    setForm(f => ({
      ...f,
      pickup:  { address: trip.pickup_address,  lat: null, lon: null },
      dropoff: { address: trip.dropoff_address, lat: null, lon: null },
    }));
    setView('book');
  }

  function setPickup(val)  { setForm(f => ({ ...f, pickup: val })); }
  function setDropoff(val) { setForm(f => ({ ...f, dropoff: val })); }

  // Step 1 → Step 2
  function step1Next() {
    setBookError('');
    if (!form.pickup.address.trim())  { setBookError(t('booking.err_no_pickup')); return; }
    if (!form.dropoff.address.trim()) { setBookError(t('booking.err_no_dropoff')); return; }
    if (form.pickup.address.trim().toLowerCase() === form.dropoff.address.trim().toLowerCase()) {
      setBookError(t('booking.err_same_address')); return;
    }
    setStep(2);
  }

  // Step 2 → Step 3 (fetch estimate)
  async function step2Next() {
    setBookError('');
    const depDate = parseDate(form.date, form.time);
    if (!depDate) { setBookError(t('booking.err_invalid_dt')); return; }
    if (depDate <= new Date()) { setBookError(t('booking.err_past_date')); return; }
    if (form.hasReturn) {
      const retDate = parseDate(form.retDate, form.retTime);
      if (!retDate) { setBookError(t('booking.err_invalid_ret')); return; }
      if (retDate <= depDate) { setBookError(t('booking.err_ret_before_dep')); return; }
    }
    setEstimating(true);
    try {
      const { data } = await tripService.estimate({
        pickup_address:  form.pickup.address,
        dropoff_address: form.dropoff.address,
        passenger_count: parseInt(form.passengers) || 1,
        has_return:      form.hasReturn,
      });
      setEstimate(data);
      setStep(3);
    } catch (e) {
      setBookError(e.response?.data?.error || t('booking.err_create'));
    } finally {
      setEstimating(false);
    }
  }

  // Step 3 → Step 4 (driver selection, optional)
  async function step3Next(driver) {
    const chosen = driver !== undefined ? driver : selectedDriver;
    if (chosen) {
      // Verify the selected driver is still available at departure time
      const depDate = parseDate(form.date, form.time);
      try {
        const params = {
          departure_at:     depDate.toISOString(),
          duration_minutes: estimate?.duration_minutes,
          ...(form.hasReturn ? { return_at: parseDate(form.retDate, form.retTime)?.toISOString() } : {}),
        };
        const { data } = await driverService.availabilityCheck(chosen.id, params);
        if (!data.available) {
          const conflicts = data.conflicts?.map(c => formatDate(c.departure_at, i18n.language)).join(', ') || '';
          setDriverAvailMsg(
            t('booking.driver_conflict', { conflicts: conflicts ? `: ${conflicts}` : '' })
          );
          return;
        }
      } catch {
        // If check fails, allow anyway
      }
    }
    setSelectedDriver(chosen ?? null);
    setDriverAvailMsg('');
    setStep(4);
  }

  // Step 4 → Step 5 (confirm booking, create trip)
  async function step4Confirm() {
    if (!estimate) return;
    const depDate = parseDate(form.date, form.time);
    if (!depDate) {
      Alert.alert(t('common.error'), t('booking.err_invalid_dep'));
      return;
    }
    setBookError('');
    setBooking(true);
    try {
      const body = {
        pickup_address:      form.pickup.address,
        dropoff_address:     form.dropoff.address,
        departure_at:        depDate.toISOString(),
        passenger_count:     parseInt(form.passengers) || 1,
        pickup_lat:          estimate.pickup.lat,
        pickup_lon:          estimate.pickup.lon,
        dropoff_lat:         estimate.dropoff.lat,
        dropoff_lon:         estimate.dropoff.lon,
        distance_km:         estimate.distance_km,
        duration_minutes:    estimate.duration_minutes,
        estimated_cost:      estimate.estimated_cost,
        client_notes:        form.notes || null,
        preferred_driver_id: selectedDriver?.id || null,
      };
      if (form.hasReturn) {
        const retDate = parseDate(form.retDate, form.retTime);
        if (retDate) body.return_at = retDate.toISOString();
      }
      const { data: created } = await tripService.create(body);
      setTripId(created?.trip?.id || null);
      setStep(5);
      setListLoading(true);
      loadTrips();
    } catch (e) {
      const err = e.response?.data;
      let msg = err?.error || t('booking.err_create');
      if (err?.code === 'INSUFFICIENT_LEAD_TIME') {
        msg = t('booking.err_lead_time', { hours: err.min_lead_hours });
      } else if (err?.code === 'MISSING_COORDINATES') {
        msg = t('booking.err_missing_coords');
      } else if (err?.code === 'OVERLAPPING_TRIP') {
        msg = t('booking.err_overlap', { number: err.trip_number });
      } else if (err?.code === 'TOO_FAR_IN_ADVANCE') {
        msg = t('booking.err_too_far', { days: err.max_advance_days });
      }
      Alert.alert(t('booking.err_create_title'), msg);
      setBookError(msg);
    } finally {
      setBooking(false);
    }
  }

  // Step 5: Reserve mobility tickets
  async function reserveTickets() {
    setPaymentError('');
    const nums = ticketInput
      .split(/[\s,;]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));

    if (!nums.length) {
      setPaymentError('payment.err_no_tickets');
      return;
    }
    if (ticketInfo && nums.length < ticketInfo.required_count) {
      setPaymentError(t('payment.err_not_enough', {
        count: ticketInfo.required_count, provided: nums.length,
      }));
      return;
    }
    setPaymentLoading(true);
    try {
      await ticketService.reserve({ trip_id: tripId, ticket_numbers: nums });
      setPaymentDone(true);
      setTimeout(() => setStep(6), 800);
    } catch (e) {
      const err = e.response?.data;
      if (err?.code === 'INSUFFICIENT_TICKETS') {
        setPaymentError(t('payment.err_not_enough', { count: err.required_count, provided: nums.length }));
      } else if (err?.code === 'TICKETS_UNAVAILABLE') {
        setPaymentError('payment.err_unavailable');
      } else if (err?.code === 'TICKETS_NOT_OWNED') {
        setPaymentError('payment.err_not_owned');
      } else {
        setPaymentError(err?.error || 'payment.err_generic');
      }
    } finally {
      setPaymentLoading(false);
    }
  }

  // Step 5: When method switches to 'card', register setup intent if not yet done
  function selectPaymentMethod(method) {
    setPaymentMethod(method);
    setPaymentError('');
    setPaymentDone(false);
    if (method === 'card' && !stripeInitiated && tripId) {
      paymentService.setupIntent({ trip_id: tripId })
        .then(({ data }) => {
          setClientSecret(data.client_secret || '');
          setStripePaymentId(data.payment_id || null);
          setStripeInitiated(true);
        })
        .catch((e) => {
          const msg = e?.response?.data?.error;
          setPaymentError(msg || 'payment.err_stripe_no_key');
        });
    }
  }

  // ── Driver card tap: select and immediately proceed if available ──────────────
  async function selectDriver(driver) {
    setDriverAvailMsg('');
    setSelectedDriver(driver);
    await step3Next(driver);
  }

  // ── Sub-renders ──────────────────────────────────────────────────────────────

  function renderList() {
    return (
      <View style={{ flex: 1 }}>
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

        {listLoading ? (
          <ActivityIndicator color={c.teal600} style={{ marginTop: 60 }} />
        ) : trips.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={{ fontSize: 40 }}>🗺️</Text>
            <Text style={styles.emptyTitle}>{t('trips.no_trips_title')}</Text>
            <Text style={styles.emptyDesc}>{t('trips.no_trips_desc')}</Text>
            <TouchableOpacity style={[sh.btnPrimary, { paddingHorizontal: spacing.xl }]}
              onPress={goBook}>
              <Text style={sh.btnPrimaryText}>{t('trips.book_trip_btn')}</Text>
            </TouchableOpacity>
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
            renderItem={({ item }) => <TripCard trip={item} onRebook={handleRebook} />}
          />
        )}
      </View>
    );
  }

  function renderBookForm() {
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 200 }}
      >
        <View style={{ padding: spacing.lg }}>
          <StepBar step={step} />
        </View>

        {!!bookError && (
          <View style={[sh.errorBox, { marginHorizontal: spacing.lg }]}>
            <Text style={sh.errorText}>{bookError}</Text>
          </View>
        )}

        {/* ── Step 1: Addresses ── */}
        {step === 1 && (
          <View style={[sh.card, { marginTop: 0 }]}>
            <Text style={sh.sectionTitle}>{t('booking.step_addresses')}</Text>
            <AddressInput
              label={t('booking.pickup_label')}
              value={form.pickup}
              onSelect={setPickup}
              placeholder={t('booking.pickup_placeholder')}
            />
            <AddressInput
              label={t('booking.dropoff_label')}
              value={form.dropoff}
              onSelect={setDropoff}
              placeholder={t('booking.dropoff_placeholder')}
            />

            <Text style={[sh.label, { marginTop: spacing.sm }]}>{t('booking.passengers_label')}</Text>
            <View style={styles.numRow}>
              {['1', '2', '3', '4', '5', '6', '7', '8'].map(n => (
                <TouchableOpacity key={n}
                  style={[styles.numBtn, form.passengers === n && styles.numBtnActive]}
                  onPress={() => setForm(f => ({ ...f, passengers: n }))}>
                  <Text style={[styles.numBtnText, form.passengers === n && styles.numBtnTextActive]}>
                    {n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={[sh.btnPrimary, { marginTop: spacing.lg }]}
              onPress={step1Next}>
              <Text style={sh.btnPrimaryText}>{t('booking.btn_next')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Step 2: Date & Time ── */}
        {step === 2 && (
          <View style={[sh.card, { marginTop: 0 }]}>
            <Text style={sh.sectionTitle}>{t('booking.step_schedule')}</Text>

            <Text style={sh.label}>{t('booking.departure_date')}</Text>
            <DateSegment
              value={form.date}
              onChange={v => setForm(f => ({ ...f, date: v }))}
            />
            <Text style={[sh.label, { marginTop: spacing.sm }]}>{t('booking.departure_time')}</Text>
            <TimeSegment
              value={form.time}
              onChange={v => setForm(f => ({ ...f, time: v }))}
            />

            <View style={[styles.switchRow, { marginTop: spacing.md }]}>
              <Text style={sh.label}>{t('booking.return_trip')}</Text>
              <Switch
                value={form.hasReturn}
                onValueChange={v => setForm(f => ({ ...f, hasReturn: v }))}
                trackColor={{ false: c.gray300, true: c.teal500 }}
                thumbColor={form.hasReturn ? c.teal600 : c.gray400}
              />
            </View>

            {form.hasReturn && (
              <>
                <Text style={[sh.label, { marginTop: spacing.sm }]}>{t('booking.return_date')}</Text>
                <DateSegment
                  value={form.retDate}
                  onChange={v => setForm(f => ({ ...f, retDate: v }))}
                />
                <Text style={[sh.label, { marginTop: spacing.sm }]}>{t('booking.return_time')}</Text>
                <TimeSegment
                  value={form.retTime}
                  onChange={v => setForm(f => ({ ...f, retTime: v }))}
                />
              </>
            )}

            <View style={styles.stepActions}>
              <TouchableOpacity style={[sh.btnSecondary, { flex: 1 }]}
                onPress={() => { setBookError(''); setStep(1); }}>
                <Text style={sh.btnSecondaryText}>{t('booking.btn_back')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[sh.btnPrimary, { flex: 2 }, estimating && sh.btnPrimaryDisabled]}
                onPress={step2Next}
                disabled={estimating}>
                {estimating
                  ? <ActivityIndicator color={c.white} />
                  : <Text style={sh.btnPrimaryText}>{t('booking.btn_estimate')}</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Step 3: Driver selection ── */}
        {step === 3 && (
          <View style={[sh.card, { marginTop: 0 }]}>
            <Text style={sh.sectionTitle}>{t('booking.driver_step_title')}</Text>
            <Text style={[styles.driverSubtitle]}>{t('booking.driver_step_subtitle')}</Text>

            {/* Search box */}
            <TextInput
              style={[sh.input, { marginBottom: spacing.sm }]}
              placeholder={t('booking.driver_search_ph')}
              placeholderTextColor={c.gray400}
              value={driverSearchQuery}
              onChangeText={setDriverSearchQuery}
              autoCorrect={false}
            />

            {/* Availability warning */}
            {!!driverAvailMsg && (
              <View style={[sh.errorBox, { marginBottom: spacing.sm }]}>
                <Text style={sh.errorText}>{driverAvailMsg}</Text>
              </View>
            )}

            {/* Selected driver highlight */}
            {selectedDriver && (
              <View style={styles.selectedDriverBadge}>
                <Text style={styles.selectedDriverText}>
                  ✅ {t('booking.selected_driver', { name: `${selectedDriver.first_name} ${selectedDriver.last_name}` })}
                </Text>
                <TouchableOpacity onPress={() => { setSelectedDriver(null); setDriverAvailMsg(''); }}>
                  <Text style={styles.clearDriver}>✕</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Search results (shown when query ≥ 2 chars) */}
            {driverSearchQuery.length >= 2 && (
              <View>
                <Text style={styles.driverListLabel}>{t('booking.search_results')}</Text>
                {driverResults.length === 0 ? (
                  <Text style={styles.noDrivers}>{t('booking.search_empty')}</Text>
                ) : (
                  driverResults.map(d => (
                    <DriverCard key={d.id} driver={d}
                      selected={selectedDriver?.id === d.id}
                      onPress={() => selectDriver(d)} />
                  ))
                )}
              </View>
            )}

            {/* Nearby drivers (when no search query) */}
            {driverSearchQuery.length < 2 && (
              <View>
                <Text style={styles.driverListLabel}>
                  {driverLoading ? t('booking.nearby_loading') : t('booking.nearby_title')}
                </Text>
                {driverLoading ? (
                  <ActivityIndicator color={c.teal600} style={{ marginTop: spacing.md }} />
                ) : nearbyDrivers.length === 0 ? (
                  <Text style={styles.noDrivers}>{t('booking.nearby_empty')}</Text>
                ) : (
                  nearbyDrivers.map(d => (
                    <DriverCard key={d.id} driver={d}
                      selected={selectedDriver?.id === d.id}
                      onPress={() => selectDriver(d)} />
                  ))
                )}
              </View>
            )}

            <View style={styles.stepActions}>
              <TouchableOpacity style={[sh.btnSecondary, { flex: 1 }]}
                onPress={() => { setDriverAvailMsg(''); setStep(2); }}>
                <Text style={sh.btnSecondaryText}>{t('booking.btn_back')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[sh.btnPrimary, { flex: 2 }]}
                onPress={() => step3Next()}>
                <Text style={sh.btnPrimaryText}>
                  {selectedDriver ? t('booking.btn_confirm_driver') : t('booking.btn_no_pref')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Step 4: Summary + Notes + Confirm ── */}
        {step === 4 && estimate && (
          <View style={[sh.card, { marginTop: 0 }]}>
            <Text style={sh.sectionTitle}>{t('booking.summary_title')}</Text>

            <EstRow label={t('booking.summary_pickup')}     value={estimate.pickup.address} />
            <EstRow label={t('booking.summary_dropoff')}    value={estimate.dropoff.address} />
            <EstRow label={t('booking.summary_date')}       value={formatDate(parseDate(form.date, form.time)?.toISOString(), i18n.language)} />
            <EstRow label={t('booking.summary_passengers')} value={form.passengers} />
            <EstRow label={t('booking.summary_distance')}   value={`${estimate.distance_km} km`} />
            <EstRow label={t('booking.summary_duration')}   value={`${estimate.duration_minutes} min`} />
            {selectedDriver && (
              <EstRow label={t('booking.summary_pref_driver')}
                value={`${selectedDriver.first_name} ${selectedDriver.last_name}`} />
            )}
            <EstRow label={t('booking.summary_cost')}
              value={`${estimate.estimated_cost} ${currencySymbol(estimate.currency || currency)}`} highlight />

            <Text style={[sh.label, { marginTop: spacing.lg }]}>{t('booking.notes_label')}</Text>
            <TextInput
              style={[sh.input, { height: 72, textAlignVertical: 'top' }]}
              placeholder={t('booking.notes_placeholder')}
              placeholderTextColor={c.gray400}
              value={form.notes}
              onChangeText={v => setForm(f => ({ ...f, notes: v }))}
              multiline
              blurOnSubmit
              returnKeyType="done"
            />

            <View style={styles.stepActions}>
              <TouchableOpacity style={[sh.btnSecondary, { flex: 1 }]}
                onPress={() => { setBookError(''); setStep(3); }}>
                <Text style={sh.btnSecondaryText}>{t('booking.btn_back')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[sh.btnPrimary, { flex: 2, backgroundColor: c.green600 },
                  booking && sh.btnPrimaryDisabled]}
                onPress={step4Confirm}
                disabled={booking}>
                {booking
                  ? <ActivityIndicator color={c.white} />
                  : <Text style={sh.btnPrimaryText}>{t('booking.btn_confirm_trip')}</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Step 5: Payment ── */}
        {step === 5 && (
          <View style={[sh.card, { marginTop: 0 }]}>
            <Text style={sh.sectionTitle}>{t('payment.title')}</Text>

            {estimate && (
              <View style={styles.paymentTotal}>
                <Text style={styles.paymentTotalLabel}>{t('payment.estimated_amount')}</Text>
                <Text style={styles.paymentTotalValue}>
                  {estimate.estimated_cost} {currencySymbol(estimate.currency || currency)}
                </Text>
              </View>
            )}

            {/* ── Method selector ── */}
            <Text style={[sh.label, { marginBottom: spacing.sm }]}>{t('payment.choose_method')}</Text>
            <View style={styles.methodRow}>
              {['card', 'mobility'].map(method => (
                <TouchableOpacity
                  key={method}
                  style={[styles.methodBtn, effectiveMethod === method && styles.methodBtnActive]}
                  onPress={() => selectPaymentMethod(method)}>
                  <Text style={[styles.methodBtnText, effectiveMethod === method && styles.methodBtnTextActive]}>
                    {t(`payment.method_${method}`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Global payment error */}
            {!!paymentError && (
              <View style={[sh.errorBox, { marginBottom: spacing.sm }]}>
                <Text style={sh.errorText}>{t(paymentError)}</Text>
              </View>
            )}

            {/* ── Card (Stripe) ── */}
            {effectiveMethod === 'card' && (!paymentError || stripeInitiated) && (
              <StripeCardForm
                clientSecret={clientSecret}
                paymentId={stripePaymentId}
                stripeInitiated={stripeInitiated}
                onSuccess={() => { setPaymentDone(true); setTimeout(() => setStep(6), 600); }}
                onError={msg => setPaymentError(msg)}
              />
            )}

            {/* ── Mobility tickets ── */}
            {effectiveMethod === 'mobility' && (
              <View>
                <View style={styles.paymentInfo}>
                  <Text style={{ fontSize: 32, textAlign: 'center', marginBottom: spacing.sm }}>🎟️</Text>
                  <Text style={styles.paymentInfoTitle}>{t('payment.mobility_title')}</Text>
                  {ticketInfo ? (
                    <Text style={styles.paymentInfoText}>
                      {t('payment.mobility_requires', {
                        count: ticketInfo.required_count,
                        value: ticketInfo.facial_value,
                        currency: ticketInfo.currency,
                      })}
                    </Text>
                  ) : (
                    <ActivityIndicator color={c.teal600} style={{ marginVertical: spacing.sm }} />
                  )}
                </View>

                {ticketInfo?.available_tickets?.length > 0 && (
                  <View style={styles.availTickets}>
                    <Text style={[sh.label, { marginBottom: spacing.xs }]}>
                      {t('payment.your_tickets')}
                    </Text>
                    <Text style={styles.availTicketNums}>
                      {ticketInfo.available_tickets.map(tk => tk.ticket_number).join(', ')}
                    </Text>
                  </View>
                )}

                <Text style={[sh.label, { marginTop: spacing.sm }]}>
                  {t('payment.ticket_label')}
                </Text>
                <TextInput
                  style={[sh.input, { marginBottom: spacing.sm }]}
                  placeholder={t('payment.ticket_placeholder')}
                  placeholderTextColor={c.gray400}
                  value={ticketInput}
                  onChangeText={setTicketInput}
                  keyboardType="default"
                />
                <Text style={styles.ticketHint}>
                  {t('payment.ticket_hint', { count: ticketInfo?.required_count ?? '…' })}
                </Text>

                {paymentDone ? (
                  <View style={[styles.paymentInfo, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0', marginTop: spacing.md }]}>
                    <Text style={{ color: c.green600, fontWeight: '600', textAlign: 'center' }}>
                      {t('payment.tickets_reserved')}
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[sh.btnPrimary, { marginTop: spacing.md },
                      paymentLoading && sh.btnPrimaryDisabled]}
                    onPress={reserveTickets}
                    disabled={paymentLoading}>
                    {paymentLoading
                      ? <ActivityIndicator color={c.white} />
                      : <Text style={sh.btnPrimaryText}>{t('payment.btn_reserve')}</Text>
                    }
                  </TouchableOpacity>
                )}
              </View>
            )}

          </View>
        )}

        {/* ── Step 6: Success ── */}
        {step === 6 && (
          <View style={[sh.card, { marginTop: 0, alignItems: 'center' }]}>
            <Text style={{ fontSize: 56, marginBottom: spacing.md }}>✅</Text>
            <Text style={styles.successTitle}>{t('booking.success_title')}</Text>
            <Text style={styles.successDesc}>
              {selectedDriver
                ? t('booking.success_desc_driver')
                : t('booking.success_desc')}
            </Text>
            <TouchableOpacity style={[sh.btnPrimary, { alignSelf: 'stretch', marginTop: spacing.xl }]}
              onPress={() => { setView('list'); setListLoading(true); loadTrips(); }}>
              <Text style={sh.btnPrimaryText}>{t('booking.btn_view_trips')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[sh.btnSecondary, { alignSelf: 'stretch' }]}
              onPress={resetBook}>
              <Text style={sh.btnSecondaryText}>{t('booking.btn_new_trip')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    );
  }

  // ── Main render ──────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={sh.screen}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {view === 'book' && step < 5 && (
            <TouchableOpacity onPress={goList} style={{ marginRight: spacing.md }}>
              <Text style={{ fontSize: 22, color: c.teal600 }}>←</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.headerTitle}>
            {view === 'list' ? t('trips.title') : t('booking.title')}
          </Text>
        </View>
        {view === 'list' && (
          <TouchableOpacity style={styles.bookBtn} onPress={goBook}>
            <Text style={styles.bookBtnText}>{t('trips.book_btn')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {view === 'list' ? (
        renderList()
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          {renderBookForm()}
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

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

function TripCard({ trip, onRebook }) {
  const { t, i18n } = useTranslation();
  const c      = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { currency } = useAppConfig();
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const STATUS_STYLE = {
    pending:   { bg: c.amber50,  text: c.amber700,  label: t('trips.badge_pending')   },
    assigned:  { bg: c.teal100,  text: c.teal700,   label: t('trips.badge_assigned')  },
    completed: { bg: '#f0fdf4',       text: c.green600,  label: t('trips.badge_completed') },
    cancelled: { bg: c.red50,    text: c.red500,    label: t('trips.badge_cancelled') },
  };
  const s = STATUS_STYLE[trip.status] || STATUS_STYLE.pending;

  const vehicle = [trip.driver_vehicle_year, trip.driver_vehicle_make, trip.driver_vehicle_model, trip.driver_vehicle_color]
    .filter(Boolean).join(' ');

  return (
    <TouchableOpacity style={styles.tripCard} onPress={() => setExpanded(e => !e)} activeOpacity={0.85}>
      {/* ── Header row ── */}
      <View style={styles.tripCardHead}>
        <Text style={styles.tripDate}>{formatDate(trip.departure_at, i18n.language)}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={[styles.badge, { backgroundColor: s.bg }]}>
            <Text style={[styles.badgeText, { color: s.text }]}>{s.label}</Text>
          </View>
          <Text style={{ fontSize: 12, color: c.gray400 }}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </View>

      {/* ── Route ── */}
      <Text style={styles.routeFrom} numberOfLines={expanded ? 0 : 1}>📍 {trip.pickup_address}</Text>
      <Text style={styles.routeTo}   numberOfLines={expanded ? 0 : 1}>🏁 {trip.dropoff_address}</Text>

      {/* ── Footer (always visible) ── */}
      <View style={styles.tripFoot}>
        <Text style={styles.tripMeta}>{t('trips.passengers', { count: trip.passenger_count })}</Text>
        {trip.estimated_cost
          ? <Text style={styles.tripPrice}>
              {parseFloat(trip.estimated_cost).toFixed(2)} {currencySymbol(trip.currency || currency)}
            </Text>
          : null}
      </View>

      {/* ── Expanded detail ── */}
      {expanded && (
        <View style={styles.tripDetail}>

          {/* Addresses */}
          <DetailRow icon="🟢" label={t('trips.confirm_pickup')}   value={trip.pickup_address} />
          <DetailRow icon="🔴" label={t('trips.confirm_dropoff')}  value={trip.dropoff_address} />

          {/* Timing */}
          <DetailRow icon="📅" label={t('trips.confirm_departure')} value={formatDate(trip.departure_at, i18n.language)} />
          {trip.return_at && (
            <DetailRow icon="🔄" label={t('trips.confirm_return')} value={formatDate(trip.return_at, i18n.language)} />
          )}

          {/* Passengers + trip type badge */}
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
          {trip.return_at && trip.duration_minutes && (
            <DetailRow icon="⏱️" label={t('trips.duration_return')}
              value={formatDuration(parseInt(trip.duration_minutes))} />
          )}

          {/* Cost — label changes by status */}
          {trip.estimated_cost && trip.status !== 'cancelled' && (
            <DetailRow icon="💰"
              label={
                trip.status === 'completed' ? t('trips.amount_charged') :
                trip.status === 'pending'   ? t('trips.estimated_cost') :
                                              t('trips.amount_to_charge')
              }
              value={`${parseFloat(trip.estimated_cost).toFixed(2)} ${currencySymbol(trip.payment_currency || currency)}`}
            />
          )}

          {/* Driver */}
          {trip.driver_name && (
            <DetailRow icon="🚗" label={t('trips.driver_label')} value={trip.driver_name} />
          )}
          {trip.booked_by_name && (
            <DetailRow icon="📋" label={t('trips.booked_by')} value={trip.booked_by_name} />
          )}
          {trip.driver_phone && trip.status === 'assigned' && (
            <DetailRow icon="📞" label={t('trips.driver_phone')} value={trip.driver_phone} />
          )}

          {/* Vehicle block — assigned trips only */}
          {trip.status === 'assigned' && !!vehicle && (
            <View style={styles.vehicleBlock}>
              <Text style={styles.vehicleBlockLabel}>🚘 {t('trips.vehicle_info')}</Text>
              <Text style={styles.vehicleBlockValue}>{vehicle}</Text>
              {trip.driver_license_plate && (
                <Text style={styles.vehicleBlockPlate}>🪪 {trip.driver_license_plate}</Text>
              )}
            </View>
          )}

          {/* Client notes */}
          {trip.client_notes && (
            <DetailRow icon="💬" label={t('trips.client_notes_label')} value={trip.client_notes} />
          )}

          {/* Payment block */}
          {trip.payment_status && (
            <View style={[styles.paymentBlock,
              trip.payment_status === 'paid'       ? styles.paymentBlockPaid :
              trip.payment_status === 'authorized' ? styles.paymentBlockAuth :
              trip.payment_status === 'failed'     ? styles.paymentBlockFailed :
                                                     styles.paymentBlockDefault]}>
              <Text style={styles.paymentBlockMethod}>
                {trip.payment_method === 'mobility' ? '🎫' : trip.payment_method === 'manual' ? '💵' : '💳'}
                {' '}{t(`trips.payment_method_${trip.payment_method}`, { defaultValue: trip.payment_method || '—' })}
              </Text>
              <Text style={styles.paymentBlockStatus}>
                {trip.payment_status === 'paid'
                  ? `✅ ${t('trips.amount_charged')}${trip.payment_amount ? ` — ${parseFloat(trip.payment_amount).toFixed(2)} ${currencySymbol(trip.payment_currency || currency)}` : ''}`
                  : trip.payment_status === 'authorized'
                  ? `🔒 ${t('trips.payment_status_authorized')}${trip.payment_amount ? ` — ${parseFloat(trip.payment_amount).toFixed(2)} ${currencySymbol(trip.payment_currency || currency)}` : ''}`
                  : trip.payment_status === 'failed'
                  ? `⚠️ ${t('trips.payment_status_failed')}`
                  : t(`trips.payment_status_${trip.payment_status}`, { defaultValue: trip.payment_status })}
              </Text>
            </View>
          )}

          {/* Trip number */}
          {trip.trip_number && (
            <Text style={styles.tripNumberLabel}>T-{trip.trip_number}</Text>
          )}

          {/* Chat / Book again buttons */}
          <View style={styles.actionRow}>
            {trip.driver_id && (
              <TouchableOpacity
                style={styles.rebookBtn}
                onPress={() => navigation.navigate('Messages', {
                  tripId:     trip.id,
                  tripNumber: trip.trip_number,
                  otherName:  trip.driver_name || t('messages.no_driver'),
                  ts: Date.now(),
                })}
                activeOpacity={0.8}
              >
                <Text style={styles.rebookBtnText}>💬 {t('messages.open_chat')}</Text>
              </TouchableOpacity>
            )}
            {onRebook && (
              <TouchableOpacity
                style={styles.rebookBtn}
                onPress={() => onRebook(trip)}
                activeOpacity={0.8}
              >
                <Text style={styles.rebookBtnText}>📋 {t('trips.book_again')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

function DriverCard({ driver, selected, onPress }) {
  const c      = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const stars = driver.average_rating
    ? `★ ${parseFloat(driver.average_rating).toFixed(1)}`
    : '';
  const vehicle = [driver.vehicle_year, driver.vehicle_make, driver.vehicle_model]
    .filter(Boolean).join(' ');
  const dist = driver.distance_km != null ? `${driver.distance_km} km` : '';

  return (
    <TouchableOpacity
      style={[styles.driverCard, selected && styles.driverCardSelected]}
      onPress={onPress}>
      <View style={styles.driverCardAvatar}>
        <Text style={styles.driverCardInitial}>
          {driver.first_name?.[0]}{driver.last_name?.[0]}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.driverCardName}>
          {driver.first_name} {driver.last_name}
        </Text>
        {!!vehicle && <Text style={styles.driverCardVehicle}>{vehicle}</Text>}
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: 2 }}>
          {!!stars && <Text style={styles.driverCardMeta}>{stars}</Text>}
          {!!dist  && <Text style={styles.driverCardMeta}>📍 {dist}</Text>}
        </View>
      </View>
      {selected && <Text style={{ color: c.teal600, fontWeight: '700' }}>✓</Text>}
    </TouchableOpacity>
  );
}

// ── Stripe card form ───────────────────────────────────────────────────────────
// Separated into its own component so useStripe() hook is called at the right
// level (it requires StripeProvider to be an ancestor in the tree).

function StripeCardForm({ clientSecret, paymentId, stripeInitiated, onSuccess, onError }) {
  const { t } = useTranslation();
  const { confirmSetupIntent } = useStripe();
  const c      = useColors();
  const sh     = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [cardComplete,    setCardComplete]    = useState(false);
  const [cardholderName,  setCardholderName]  = useState('');
  const [postalCode,      setPostalCode]      = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSave() {
    if (!clientSecret) {
      onError('payment.err_stripe_no_key');
      return;
    }
    if (!cardComplete) {
      onError('payment.err_card_required');
      return;
    }
    setSaving(true);
    onError('');
    try {
      const { setupIntent, error } = await confirmSetupIntent(clientSecret, {
        paymentMethodType: 'Card',
        paymentMethodData: {
          billingDetails: {
            name:    cardholderName.trim() || undefined,
            address: { postalCode: postalCode.trim() || undefined },
          },
        },
      });
      if (error) {
        onError(error.message || 'payment.err_generic');
        return;
      }
      if (setupIntent?.status === 'Succeeded') {
        await paymentService.confirm({
          payment_id:        paymentId,
          setup_intent_id:   setupIntent.id,
          payment_method_id: setupIntent.paymentMethodId,
        });
        setDone(true);
        onSuccess();
      } else {
        onError('payment.err_generic');
      }
    } catch (e) {
      onError(e.response?.data?.error || 'payment.err_generic');
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <View style={[styles.paymentInfo, { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }]}>
        <Text style={{ color: c.green600, fontWeight: '600', textAlign: 'center' }}>
          {t('payment.stripe_registered')}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.paymentInfo}>
        <Text style={{ fontSize: 32, textAlign: 'center', marginBottom: spacing.sm }}>💳</Text>
        <Text style={styles.paymentInfoTitle}>{t('payment.stripe_title')}</Text>
        <Text style={[styles.paymentInfoText, { marginBottom: spacing.md }]}>
          {t('payment.stripe_card_hint')}
        </Text>
        {/* Cardholder name */}
        <Text style={sh.label}>{t('payment.cardholder_name')}</Text>
        <TextInput
          style={[sh.input, { marginBottom: spacing.sm }]}
          value={cardholderName}
          onChangeText={setCardholderName}
          placeholder={t('payment.cardholder_name_placeholder')}
          placeholderTextColor={c.gray400}
          autoComplete="name"
          autoCorrect={false}
        />

        {/* Card number / expiry / CVC */}
        <Text style={[sh.label, { marginBottom: spacing.sm }]}>
          {t('payment.stripe_card_label')}
        </Text>
        {!stripeInitiated ? (
          <ActivityIndicator color={c.teal600} style={{ marginVertical: spacing.md }} />
        ) : (
          <CardField
            postalCodeEnabled={false}
            style={styles.cardField}
            cardStyle={styles.cardFieldInner}
            onCardChange={details => setCardComplete(details.complete)}
          />
        )}

        {/* Postal code */}
        <Text style={sh.label}>{t('payment.postal_code')}</Text>
        <TextInput
          style={[sh.input, { marginBottom: spacing.sm }]}
          value={postalCode}
          onChangeText={v => setPostalCode(v.toUpperCase())}
          placeholder="A1A 1A1"
          placeholderTextColor={c.gray400}
          autoComplete="postal-code"
          autoCorrect={false}
          autoCapitalize="characters"
          maxLength={10}
        />
      </View>
      <TouchableOpacity
        style={[sh.btnPrimary, { marginTop: spacing.md },
          (!cardComplete || saving || !stripeInitiated || !postalCode.trim()) && sh.btnPrimaryDisabled]}
        onPress={handleSave}
        disabled={!cardComplete || saving || !stripeInitiated || !postalCode.trim()}>
        {saving
          ? <ActivityIndicator color={c.white} />
          : <Text style={sh.btnPrimaryText}>{t('payment.btn_save_card')}</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

function EstRow({ label, value, highlight }) {
  const c      = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.estRow}>
      <Text style={styles.estLabel}>{label}</Text>
      <Text style={[styles.estValue,
        highlight && { color: c.teal700, fontWeight: '700', fontSize: 15 }]}>
        {value}
      </Text>
    </View>
  );
}

// ── Segmented date / time inputs ──────────────────────────────────────────────

function DateSegment({ value, onChange }) {
  const { t } = useTranslation();
  const c      = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const parts = value ? value.split('-') : ['', '', ''];
  const [y, setY] = useState(parts[0] || '');
  const [m, setM] = useState(parts[1] || '');
  const [d, setD] = useState(parts[2] || '');
  const mRef = useRef(null);
  const dRef = useRef(null);

  function emit(yy, mm, dd) {
    if (yy.length === 4 && mm.length === 2 && dd.length === 2) {
      onChange(`${yy}-${mm}-${dd}`);
    } else {
      onChange('');
    }
  }

  return (
    <View style={styles.segRow}>
      <TextInput style={[styles.segInput, { flex: 2 }]}
        placeholder={t('booking.date_year_ph')} keyboardType="numeric" maxLength={4}
        value={y}
        onChangeText={v => { setY(v); emit(v, m, d); if (v.length === 4) mRef.current?.focus(); }} />
      <Text style={styles.segSep}>-</Text>
      <TextInput ref={mRef} style={[styles.segInput, { flex: 1 }]}
        placeholder={t('booking.date_month_ph')} keyboardType="numeric" maxLength={2}
        value={m}
        onChangeText={v => { setM(v); emit(y, v, d); if (v.length === 2) dRef.current?.focus(); }} />
      <Text style={styles.segSep}>-</Text>
      <TextInput ref={dRef} style={[styles.segInput, { flex: 1 }]}
        placeholder={t('booking.date_day_ph')} keyboardType="numeric" maxLength={2}
        value={d}
        onChangeText={v => { setD(v); emit(y, m, v); }} />
    </View>
  );
}

function TimeSegment({ value, onChange }) {
  const { t } = useTranslation();
  const c      = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const parts = value ? value.split(':') : ['', ''];
  const [h,   setH]   = useState(parts[0] || '');
  const [min, setMin] = useState(parts[1] || '');
  const minRef = useRef(null);

  function emit(hh, mm) {
    if (hh.length === 2 && mm.length === 2) {
      onChange(`${hh}:${mm}`);
    } else {
      onChange('');
    }
  }

  return (
    <View style={styles.segRow}>
      <TextInput style={[styles.segInput, { flex: 1 }]}
        placeholder={t('booking.time_hour_ph')} keyboardType="numeric" maxLength={2}
        value={h}
        onChangeText={v => { setH(v); emit(v, min); if (v.length === 2) minRef.current?.focus(); }} />
      <Text style={styles.segSep}>:</Text>
      <TextInput ref={minRef} style={[styles.segInput, { flex: 1 }]}
        placeholder={t('booking.time_min_ph')} keyboardType="numeric" maxLength={2}
        value={min}
        onChangeText={v => { setMin(v); emit(h, v); }} />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

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
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.gray200,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.gray900 },
  bookBtn: {
    backgroundColor: c.teal600, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  bookBtnText: { color: c.white, fontWeight: '600', fontSize: 13 },

  // ── List ──
  chipBar: {
    backgroundColor: c.surface,
    borderBottomWidth: 1, borderBottomColor: c.gray100,
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

  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: c.gray700, marginTop: spacing.md },
  emptyDesc: {
    fontSize: 13, color: c.gray400, textAlign: 'center',
    marginTop: spacing.sm, marginBottom: spacing.xl, lineHeight: 20,
  },

  tripCard: {
    backgroundColor: c.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm,
    elevation: 1, shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3,
  },
  tripCardHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  tripDate:   { fontSize: 12, color: c.gray500 },
  badge:      { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
  badgeText:  { fontSize: 11, fontWeight: '600' },
  routeFrom:  { fontSize: 13, color: c.gray800, fontWeight: '500', marginBottom: 2 },
  routeTo:    { fontSize: 13, color: c.gray800 },
  tripFoot:   { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  tripMeta:   { fontSize: 12, color: c.gray500 },
  tripPrice:  { fontSize: 13, fontWeight: '600', color: c.teal700 },
  tripDriver: { fontSize: 12, color: c.teal700, marginTop: spacing.xs },
  tripTypeBadgeWrap: { marginBottom: 6 },
  tripTypeBadgeText: {
    fontSize: 11, fontWeight: '600', alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, overflow: 'hidden',
  },
  tripTypeBadgeOneWay: { backgroundColor: '#eff6ff', color: '#1d4ed8' },
  tripTypeBadgeRound:  { backgroundColor: '#faf5ff', color: '#7e22ce' },

  vehicleBlock: {
    marginBottom: 6, backgroundColor: '#eff6ff',
    borderWidth: 1, borderColor: '#bfdbfe',
    borderRadius: radius.md, padding: spacing.sm,
  },
  vehicleBlockLabel: { fontSize: 11, color: '#3b82f6', fontWeight: '600', marginBottom: 2 },
  vehicleBlockValue: { fontSize: 13, fontWeight: '700', color: '#1e3a5f' },
  vehicleBlockPlate: { fontSize: 11, color: '#1d4ed8', marginTop: 2 },

  paymentBlock: {
    marginBottom: 6, borderRadius: radius.md, borderWidth: 1, padding: spacing.sm,
  },
  paymentBlockPaid:    { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  paymentBlockAuth:    { backgroundColor: '#eff6ff', borderColor: '#bfdbfe' },
  paymentBlockFailed:  { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  paymentBlockDefault: { backgroundColor: c.gray50, borderColor: c.gray200 },
  paymentBlockMethod:  { fontSize: 11, fontWeight: '600', color: c.gray700, marginBottom: 2 },
  paymentBlockStatus:  { fontSize: 13, fontWeight: '600', color: c.gray900 },

  tripNumberLabel: { fontSize: 11, color: c.gray400, marginBottom: 4 },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },

  rebookBtn: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: c.teal100,
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  rebookBtnText: { fontSize: 13, color: c.teal700, fontWeight: '600' },
  tripDetail: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.gray100,
    gap: spacing.xs,
  },
  tripDetailRow: { flexDirection: 'row', gap: spacing.lg },
  tripDetailText: { fontSize: 12, color: c.gray600, lineHeight: 18 },

  // ── Wizard common ──
  stepBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  stepItem:       { flexDirection: 'row', alignItems: 'center' },
  stepDot: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: c.gray200,
    alignItems: 'center', justifyContent: 'center',
  },
  stepDotDone:    { backgroundColor: c.teal600 },
  stepDotActive:  { backgroundColor: c.teal600 },
  stepDotText:    { fontSize: 10, fontWeight: '700', color: c.gray400 },
  stepLabel:      { fontSize: 9, color: c.gray400, marginLeft: 3, marginRight: 3 },
  stepLabelActive:{ color: c.teal700, fontWeight: '600' },
  stepLine:       { width: 16, height: 2, backgroundColor: c.gray200, marginHorizontal: 1 },
  stepLineDone:   { backgroundColor: c.teal500 },

  numRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  numBtn: {
    width: 40, height: 40, borderRadius: radius.md,
    borderWidth: 1, borderColor: c.gray300,
    alignItems: 'center', justifyContent: 'center',
  },
  numBtnActive:     { backgroundColor: c.teal600, borderColor: c.teal600 },
  numBtnText:       { fontSize: 14, color: c.gray700 },
  numBtnTextActive: { color: c.white, fontWeight: '600' },

  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: spacing.sm,
  },
  stepActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },

  estRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: c.gray100,
  },
  estLabel: { fontSize: 13, color: c.gray500, flex: 1 },
  estValue: {
    fontSize: 13, color: c.gray800, fontWeight: '500',
    flexShrink: 1, textAlign: 'right', marginLeft: spacing.md,
  },

  successTitle: { fontSize: 20, fontWeight: '700', color: c.gray900, marginBottom: spacing.sm },
  successDesc: {
    fontSize: 14, color: c.gray500, textAlign: 'center',
    lineHeight: 22, marginBottom: spacing.sm,
  },

  // ── Segmented inputs ──
  segRow:   { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, gap: spacing.xs },
  segInput: {
    borderWidth: 1, borderColor: c.gray300, borderRadius: radius.md,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.sm + 2,
    fontSize: 16, color: c.gray900, backgroundColor: c.surface,
    textAlign: 'center',
  },
  segSep: { fontSize: 18, fontWeight: '700', color: c.gray500, paddingBottom: 2 },

  // ── Address autocomplete ──
  dropdown: {
    backgroundColor: c.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: c.gray300,
    marginTop: -spacing.sm, marginBottom: spacing.sm,
    elevation: 4, shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4,
    zIndex: 999,
  },
  dropdownItem:         { paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dropdownDivider:      { borderBottomWidth: 1, borderBottomColor: c.gray100 },
  dropdownText:         { fontSize: 13, color: c.gray800 },
  dropdownSectionLabel: { paddingHorizontal: spacing.md, paddingTop: 8, paddingBottom: 2, fontSize: 11, fontWeight: '600', color: c.gray400, textTransform: 'uppercase', letterSpacing: 0.5 },
  dropdownRecentIcon:   { fontSize: 12 },

  // ── Driver selection ──
  driverSubtitle: {
    fontSize: 13, color: c.gray500, marginBottom: spacing.md, lineHeight: 18,
  },
  driverListLabel: {
    fontSize: 12, fontWeight: '600', color: c.gray500,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: spacing.sm, marginTop: spacing.sm,
  },
  noDrivers: {
    fontSize: 13, color: c.gray400, lineHeight: 20,
    marginBottom: spacing.sm,
  },
  selectedDriverBadge: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#f0fdf4', borderRadius: radius.md,
    borderWidth: 1, borderColor: '#bbf7d0',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  selectedDriverText: { fontSize: 13, color: c.green600, fontWeight: '600', flex: 1 },
  clearDriver: { fontSize: 16, color: c.gray400, paddingLeft: spacing.sm },

  driverCard: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: c.gray200,
    borderRadius: radius.md, padding: spacing.sm,
    marginBottom: spacing.sm, backgroundColor: c.surface,
  },
  driverCardSelected: { borderColor: c.teal600, backgroundColor: c.teal50 },
  driverCardAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: c.teal600,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  driverCardInitial: { color: c.white, fontWeight: '700', fontSize: 14 },
  driverCardName:    { fontSize: 14, fontWeight: '600', color: c.gray900 },
  driverCardVehicle: { fontSize: 12, color: c.gray500, marginTop: 1 },
  driverCardMeta:    { fontSize: 11, color: c.gray400 },

  // ── Payment ──
  methodRow: {
    flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md,
  },
  methodBtn: {
    flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: c.gray300, alignItems: 'center',
  },
  methodBtnActive:     { backgroundColor: c.teal600, borderColor: c.teal600 },
  methodBtnText:       { fontSize: 11, color: c.gray700, fontWeight: '500', textAlign: 'center' },
  methodBtnTextActive: { color: c.white, fontWeight: '700' },

  paymentTotal: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.teal50, borderRadius: radius.md,
    padding: spacing.md, marginBottom: spacing.md,
  },
  paymentTotalLabel: { fontSize: 14, color: c.teal700 },
  paymentTotalValue: { fontSize: 20, fontWeight: '700', color: c.teal700 },

  paymentInfo: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: c.gray200,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  paymentInfoTitle: {
    fontSize: 15, fontWeight: '700', color: c.gray900,
    textAlign: 'center', marginBottom: spacing.sm,
  },
  paymentInfoText: {
    fontSize: 13, color: c.gray600, lineHeight: 20, textAlign: 'center',
  },

  cardField: {
    width: '100%', height: 50,
    marginBottom: spacing.sm,
    backgroundColor: '#ffffff',
    borderRadius: radius.md,
  },
  cardFieldInner: {
    backgroundColor: '#ffffff',
    textColor: '#111827',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#d1d5db',
    placeholderColor: '#9ca3af',
    cursorColor: '#0d9488',
  },

  availTickets: {
    backgroundColor: '#f0fdf4', borderRadius: radius.md,
    borderWidth: 1, borderColor: '#bbf7d0',
    padding: spacing.md, marginBottom: spacing.sm,
  },
  availTicketNums: { fontSize: 13, color: c.green600, fontWeight: '600' },
  ticketHint: { fontSize: 11, color: c.gray400, marginBottom: spacing.sm },
  });
}
