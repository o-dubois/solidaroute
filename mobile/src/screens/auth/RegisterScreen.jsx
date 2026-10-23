/**
 * RegisterScreen — 3-step registration flow
 *
 * Step 1 — Role selection (rider or volunteer driver)
 * Step 2 — Personal info form
 * Step 3 — "Check your inbox" confirmation
 */
import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppConfig }  from '../../context/AppConfigContext';
import { authService }   from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';

export default function RegisterScreen({ navigation }) {
  const { t }       = useTranslation();
  const { appName } = useAppConfig();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [step, setStep]     = useState(1);
  const [role, setRole]     = useState('');
  const [form, setForm]     = useState({
    first_name: '', last_name: '', email: '', phone: '', password: '', confirm: '',
  });
  const [loading, setLoading] = useState(false);
  const [errors,  setErrors]  = useState({});
  const [emailSentTo, setEmailSentTo] = useState('');

  const f = (k) => (v) => setForm(p => ({ ...p, [k]: v }));

  function validate() {
    const e = {};
    if (!form.first_name.trim()) e.first_name = t('auth.first_name') + ' ' + t('common.error', 'required');
    if (!form.last_name.trim())  e.last_name  = t('auth.last_name')  + ' ' + t('common.error', 'required');
    if (!form.email.includes('@')) e.email = 'Invalid email address';
    if (form.password !== form.confirm) e.confirm = t('auth.passwords_dont_match');
    if (form.password.length < 8) e.password = 'Password must be at least 8 characters';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setLoading(true);
    try {
      await authService.register({
        first_name: form.first_name,
        last_name:  form.last_name,
        email:      form.email.trim(),
        phone:      form.phone.trim() || undefined,
        password:   form.password,
        role,
      });
      setEmailSentTo(form.email.trim());
      setStep(3);
    } catch (err) {
      const code     = err.response?.data?.code;
      const pwErrors = err.response?.data?.password_errors;
      if (code === 'REGISTRATION_DISABLED') {
        setErrors({ global: t('auth.registration_disabled') });
      } else if (pwErrors?.length) {
        setErrors({ global: 'Password requirements: ' + pwErrors.join(', ') + '.' });
      } else {
        setErrors({ global: err.response?.data?.error || 'Registration error.' });
      }
    } finally { setLoading(false); }
  }

  return (
    <SafeAreaView style={sh.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled">

          {/* Brand header */}
          <View style={styles.header}>
            <View style={sh.logoBox}>
              <Text style={{ fontSize: 28 }}>⏱</Text>
            </View>
            <Text style={styles.appName}>{appName}</Text>
          </View>

          {/* ── Step 1: Role selection ─────────────────────── */}
          {step === 1 && (
            <View style={sh.card}>
              <Text style={sh.sectionTitle}>{t('auth.i_am')}</Text>

              {[
                { val: 'client', label: t('auth.a_client'), desc: t('auth.a_client_desc'), icon: '🧑' },
                { val: 'driver', label: t('auth.a_driver'), desc: t('auth.a_driver_desc'), icon: '🚗' },
              ].map(opt => (
                <TouchableOpacity
                  key={opt.val}
                  onPress={() => setRole(opt.val)}
                  style={[
                    styles.roleCard,
                    role === opt.val && styles.roleCardSelected,
                  ]}>
                  <Text style={{ fontSize: 28, marginRight: spacing.md }}>{opt.icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.roleLabel}>{opt.label}</Text>
                    <Text style={styles.roleDesc}>{opt.desc}</Text>
                  </View>
                  {role === opt.val && (
                    <Text style={{ color: c.teal600, fontSize: 18 }}>✓</Text>
                  )}
                </TouchableOpacity>
              ))}

              {role === 'driver' && (
                <View style={[sh.warnBox, { backgroundColor: c.teal50,
                  borderColor: c.teal100, marginTop: spacing.md }]}>
                  <Text style={{ color: c.teal700, fontSize: 12 }}>
                    🚗 {t('auth.driver_pending_notice')}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[sh.btnPrimary, !role && sh.btnPrimaryDisabled]}
                onPress={() => setStep(2)}
                disabled={!role}>
                <Text style={sh.btnPrimaryText}>{t('auth.continue')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Step 2: Personal info form ─────────────────── */}
          {step === 2 && (
            <View style={sh.card}>
              <TouchableOpacity onPress={() => setStep(1)} style={{ marginBottom: spacing.md }}>
                <Text style={{ color: c.gray400, fontSize: 13 }}>{t('auth.back')}</Text>
              </TouchableOpacity>
              <Text style={sh.sectionTitle}>{t('auth.my_info')}</Text>

              {!!errors.global && (
                <View style={sh.errorBox}>
                  <Text style={sh.errorText}>{errors.global}</Text>
                </View>
              )}

              {/* Name row */}
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={sh.label}>{t('auth.first_name')}</Text>
                  <TextInput style={sh.input}
                    value={form.first_name} onChangeText={f('first_name')}
                    autoCapitalize="words" placeholder="Jean"
                    placeholderTextColor={c.gray400} />
                  {!!errors.first_name && <Text style={sh.fieldError}>{errors.first_name}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={sh.label}>{t('auth.last_name')}</Text>
                  <TextInput style={sh.input}
                    value={form.last_name} onChangeText={f('last_name')}
                    autoCapitalize="words" placeholder="Tremblay"
                    placeholderTextColor={c.gray400} />
                  {!!errors.last_name && <Text style={sh.fieldError}>{errors.last_name}</Text>}
                </View>
              </View>

              {/* Email */}
              <Text style={sh.label}>{t('auth.email')}</Text>
              <TextInput style={sh.input}
                value={form.email} onChangeText={f('email')}
                keyboardType="email-address" autoCapitalize="none"
                placeholder="name@example.ca"
                placeholderTextColor={c.gray400} />
              {!!errors.email && <Text style={sh.fieldError}>{errors.email}</Text>}

              {/* Phone */}
              <Text style={sh.label}>{t('auth.phone')}</Text>
              <TextInput style={sh.input}
                value={form.phone} onChangeText={f('phone')}
                keyboardType="phone-pad"
                placeholder="+15145551234"
                placeholderTextColor={c.gray400} />
              {!!errors.phone && <Text style={sh.fieldError}>{errors.phone}</Text>}

              {/* Password */}
              <Text style={sh.label}>{t('auth.password')}</Text>
              <TextInput style={sh.input}
                value={form.password} onChangeText={f('password')}
                secureTextEntry placeholder="••••••••"
                placeholderTextColor={c.gray400} />
              {!!errors.password && <Text style={sh.fieldError}>{errors.password}</Text>}

              {/* Confirm */}
              <Text style={sh.label}>{t('auth.confirm_password')}</Text>
              <TextInput style={sh.input}
                value={form.confirm} onChangeText={f('confirm')}
                secureTextEntry placeholder="••••••••"
                placeholderTextColor={c.gray400} />
              {!!errors.confirm && <Text style={sh.fieldError}>{errors.confirm}</Text>}

              {/* Submit */}
              <TouchableOpacity
                style={[sh.btnPrimary, loading && sh.btnPrimaryDisabled]}
                onPress={handleSubmit}
                disabled={loading}>
                {loading
                  ? <ActivityIndicator color={c.white} />
                  : <Text style={sh.btnPrimaryText}>{t('auth.create_account')}</Text>
                }
              </TouchableOpacity>
            </View>
          )}

          {/* ── Step 3: Email sent confirmation ───────────── */}
          {step === 3 && (
            <View style={[sh.card, { alignItems: 'center' }]}>
              <View style={styles.bigIcon}>
                <Text style={{ fontSize: 36 }}>📧</Text>
              </View>
              <Text style={[sh.sectionTitle, { textAlign: 'center', marginBottom: spacing.sm }]}>
                {t('auth.check_email')}
              </Text>
              <Text style={{ color: c.gray500, fontSize: 14, textAlign: 'center', marginBottom: 4 }}>
                {t('auth.confirm_email_sent')}
              </Text>
              <Text style={{ color: c.teal700, fontWeight: '600', fontSize: 14,
                             marginBottom: spacing.lg, textAlign: 'center' }}>
                {emailSentTo}
              </Text>

              <View style={styles.nextStepsBox}>
                <Text style={{ fontSize: 12, color: c.gray600, lineHeight: 20 }}>
                  📌 <Text style={{ fontWeight: '600' }}>{t('auth.next_steps')}</Text>{'\n'}
                  1. {t('auth.next_step_1')}{'\n'}
                  2. {t('auth.next_step_2')}{'\n'}
                  3. {t('auth.next_step_3')}{'\n\n'}
                  ⚠️ {t('auth.link_expires')}
                </Text>
              </View>

              <TouchableOpacity
                style={[sh.btnSecondary, { width: '100%' }]}
                onPress={() => navigation.navigate('Login')}>
                <Text style={sh.btnSecondaryText}>{t('auth.back_to_login')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Login link — steps 1 and 2 only */}
          {step !== 3 && (
            <View style={styles.footer}>
              <Text style={styles.footerText}>{t('auth.already_have_account')} </Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                <Text style={styles.footerLink}>{t('auth.login')}</Text>
              </TouchableOpacity>
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(c) {
  return StyleSheet.create({
    scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: spacing.xxl },
    header: { alignItems: 'center', marginBottom: spacing.xxl, paddingHorizontal: spacing.lg },
    appName: { fontSize: 20, fontWeight: '700', color: c.gray900, marginTop: spacing.md },
    roleCard: { flexDirection: 'row', alignItems: 'center', borderWidth: 2, borderColor: c.gray300, borderRadius: radius.xl, padding: spacing.md, marginBottom: spacing.sm },
    roleCardSelected: { borderColor: c.teal500, backgroundColor: c.teal50 },
    roleLabel: { fontSize: 14, fontWeight: '600', color: c.gray900 },
    roleDesc: { fontSize: 12, color: c.gray500, marginTop: 2 },
    bigIcon: { width: 72, height: 72, backgroundColor: c.teal100, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
    nextStepsBox: { backgroundColor: c.gray100, borderWidth: 1, borderColor: c.gray200, borderRadius: radius.md, padding: spacing.md, width: '100%', marginBottom: spacing.lg },
    footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
    footerText: { fontSize: 14, color: c.gray500 },
    footerLink: { fontSize: 14, color: c.teal600, fontWeight: '600' },
  });
}
