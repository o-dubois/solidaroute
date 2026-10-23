/**
 * LoginScreen — /login equivalent
 *
 * Handles:
 *   - Email + password login
 *   - EMAIL_NOT_VERIFIED → amber banner + resend button
 *   - ACCOUNT_LOCKED     → red error
 *   - Link to Register and ForgotPassword
 */
import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth }      from '../../context/AuthContext';
import { useAppConfig } from '../../context/AppConfigContext';
import { authService }  from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';

export default function LoginScreen({ navigation }) {
  const { t }      = useTranslation();
  const { login }  = useAuth();
  const { appName } = useAppConfig();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [unverified, setUnverified] = useState(false);
  const [resend, setResend]     = useState({ loading: false, done: false });

  async function handleSubmit() {
    if (!email.trim() || !password) return;
    setError('');
    setUnverified(false);
    setLoading(true);
    try {
      await login(email.trim(), password);
      // RootNavigator detects the new user and switches to the correct tab navigator
    } catch (err) {
      const code = err.response?.data?.code;
      const msg  = err.response?.data?.error || 'Login error.';
      if (code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      else if (code === 'ACCOUNT_LOCKED') setError(t('auth.account_locked'));
      else setError(msg);
    } finally { setLoading(false); }
  }

  async function handleResend() {
    setResend({ loading: true, done: false });
    try {
      await authService.resendVerification({ email: email.trim() });
      setResend({ loading: false, done: true });
    } catch {
      setResend({ loading: false, done: false });
      setError(t('auth.failed_resend', 'Failed to send. Please try again.'));
    }
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
              <Text style={styles.logoText}>⏱</Text>
            </View>
            <Text style={styles.appName}>{appName}</Text>
            <Text style={styles.tagline}>{t('app.tagline')}</Text>
          </View>

          {/* Card */}
          <View style={sh.card}>
            <Text style={sh.sectionTitle}>{t('auth.login')}</Text>

            {/* Error banner */}
            {!!error && (
              <View style={sh.errorBox}>
                <Text style={sh.errorText}>{error}</Text>
              </View>
            )}

            {/* Unverified email banner */}
            {unverified && (
              <View style={sh.warnBox}>
                <Text style={[sh.warnText, { fontWeight: '600', marginBottom: 4 }]}>
                  {t('auth.email_not_verified')}
                </Text>
                <Text style={sh.warnText}>{t('auth.email_not_verified_desc')}</Text>
                {resend.done ? (
                  <Text style={[sh.warnText, { color: c.teal600, marginTop: 8, fontWeight:'500' }]}>
                    {t('auth.resent_success')}
                  </Text>
                ) : (
                  <TouchableOpacity onPress={handleResend} disabled={resend.loading}
                    style={{ marginTop: 8 }}>
                    <Text style={[sh.warnText, { textDecorationLine: 'underline' }]}>
                      {resend.loading ? t('auth.resending') : t('auth.resend_verification')}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Email */}
            <Text style={sh.label}>{t('auth.email')}</Text>
            <TextInput
              style={sh.input}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              placeholder="name@example.ca"
              placeholderTextColor={c.gray400}
            />

            {/* Password */}
            <Text style={sh.label}>{t('auth.password')}</Text>
            <TextInput
              style={sh.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              placeholder="••••••••"
              placeholderTextColor={c.gray400}
            />

            {/* Submit */}
            <TouchableOpacity
              style={[sh.btnPrimary, loading && sh.btnPrimaryDisabled]}
              onPress={handleSubmit}
              disabled={loading}>
              {loading
                ? <ActivityIndicator color={c.white} />
                : <Text style={sh.btnPrimaryText}>{t('auth.sign_in')}</Text>
              }
            </TouchableOpacity>

            {/* Forgot password */}
            <TouchableOpacity onPress={() => navigation.navigate('ForgotPassword')}
              style={{ marginTop: spacing.lg, alignItems: 'center' }}>
              <Text style={{ color: c.teal600, fontSize: 13 }}>
                {t('auth.forgot_password')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Register link */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>{t('auth.no_account')} </Text>
            <TouchableOpacity onPress={() => navigation.navigate('Register')}>
              <Text style={styles.footerLink}>{t('auth.register')}</Text>
            </TouchableOpacity>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(c) {
  return StyleSheet.create({
    scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: spacing.xxl },
    header: { alignItems: 'center', marginBottom: spacing.xxl, paddingHorizontal: spacing.lg },
    logoText: { fontSize: 28 },
    appName: { fontSize: 24, fontWeight: '700', color: c.gray900, marginTop: spacing.md },
    tagline: { fontSize: 13, color: c.gray500, marginTop: 4 },
    footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg, paddingHorizontal: spacing.lg },
    footerText: { fontSize: 14, color: c.gray500 },
    footerLink: { fontSize: 14, color: c.teal600, fontWeight: '600' },
  });
}
