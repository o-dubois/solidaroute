/**
 * ForgotPasswordScreen — triggers a password reset email.
 * Shows the same generic confirmation regardless of whether the email exists.
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
import { useColors, useShared, spacing } from '../../theme';

export default function ForgotPasswordScreen({ navigation }) {
  const { t }       = useTranslation();
  const { appName } = useAppConfig();
  const c  = useColors();
  const sh = useShared();
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState('');
  const styles = useMemo(() => makeStyles(c), [c]);

  async function handleSubmit() {
    if (!email.trim()) return;
    setError('');
    setLoading(true);
    try {
      await authService.forgotPassword({ email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.error || 'An error occurred. Please try again.');
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

          <View style={sh.card}>
            {sent ? (
              /* Confirmation */
              <View style={{ alignItems: 'center' }}>
                <View style={styles.bigIcon}>
                  <Text style={{ fontSize: 36 }}>✅</Text>
                </View>
                <Text style={[sh.sectionTitle, { textAlign: 'center' }]}>
                  {t('auth.check_email')}
                </Text>
                <Text style={{ color: c.gray500, fontSize: 14, textAlign: 'center',
                               lineHeight: 22 }}>
                  {t('auth.reset_link_sent')}
                </Text>
              </View>
            ) : (
              <>
                <Text style={sh.sectionTitle}>{t('auth.forgot_password_title')}</Text>
                <Text style={{ color: c.gray500, fontSize: 14, marginBottom: spacing.lg }}>
                  {t('auth.forgot_password_desc')}
                </Text>

                {!!error && (
                  <View style={sh.errorBox}>
                    <Text style={sh.errorText}>{error}</Text>
                  </View>
                )}

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

                <TouchableOpacity
                  style={[sh.btnPrimary, loading && sh.btnPrimaryDisabled]}
                  onPress={handleSubmit}
                  disabled={loading}>
                  {loading
                    ? <ActivityIndicator color={c.white} />
                    : <Text style={sh.btnPrimaryText}>{t('auth.send_reset_link')}</Text>
                  }
                </TouchableOpacity>
              </>
            )}
          </View>

          {/* Back to login */}
          <TouchableOpacity
            onPress={() => navigation.navigate('Login')}
            style={styles.backLink}>
            <Text style={{ color: c.teal600, fontSize: 14 }}>
              ← {t('auth.back_to_login')}
            </Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(c) {
  return StyleSheet.create({
    scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: spacing.xxl },
    header: { alignItems: 'center', marginBottom: spacing.xxl },
    appName: { fontSize: 20, fontWeight: '700', color: c.gray900, marginTop: spacing.md },
    bigIcon: {
      width: 72, height: 72, backgroundColor: c.teal100, borderRadius: 36,
      alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
    },
    backLink: { alignItems: 'center', marginTop: spacing.lg },
  });
}
