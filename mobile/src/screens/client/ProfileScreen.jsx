/**
 * Client Profile — user info, language selector, logout.
 */
import { useEffect, useState , useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Constants from 'expo-constants';
import { useAuth }      from '../../context/AuthContext';
import { useAppConfig } from '../../context/AppConfigContext';
import { versionService } from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';

export default function ClientProfileScreen() {
  const { t, i18n }  = useTranslation();
  const { user, logout } = useAuth();
  const { appName, frontendLanguage } = useAppConfig();
  const c  = useColors();
  const sh = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);

  const mobileVersion = Constants.expoConfig?.version ?? null;
  const [apiVersion,  setApiVersion]  = useState(null); // null = loading
  useEffect(() => {
    versionService.get()
      .then(({ data }) => setApiVersion(data.app || null))
      .catch(() => setApiVersion(false)); // false = unreachable
  }, []);

  return (
    <SafeAreaView style={sh.screen}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text style={styles.pageTitle}>{t('nav.profile')}</Text>

        {/* Avatar + name */}
        <View style={[sh.card, { alignItems: 'center', marginBottom: spacing.lg }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user?.first_name?.[0]}{user?.last_name?.[0]}
            </Text>
          </View>
          <Text style={styles.name}>{user?.first_name} {user?.last_name}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{t('profile.role_client')}</Text>
          </View>
          {user?.member_number && (
            <View style={styles.memberBadge}>
              <Text style={styles.memberText}>
                🪪 {t('profile.member_id')} : C-{String(user.member_number).padStart(4, '0')}
              </Text>
            </View>
          )}
        </View>

        {/* Info rows */}
        <View style={sh.card}>
          <InfoRow label={t('profile.email')}    value={user?.email} />
          {user?.phone && <InfoRow label={t('profile.phone')} value={user.phone} />}
          <InfoRow label={t('profile.platform')} value={appName} />
          <InfoRow label={t('profile.version_mobile')}
            value={mobileVersion ? `v${mobileVersion}` : '—'} />
          <InfoRow label={t('profile.version_api')}
            value={apiVersion === null ? '…' : apiVersion ? `v${apiVersion}` : '—'} />
        </View>

        {/* Language selector — hidden when admin has locked to a single language */}
        {frontendLanguage === 'both' && (
          <View style={[sh.card, { marginTop: spacing.md }]}>
            <Text style={[sh.label, { marginBottom: spacing.sm }]}>{t('profile.language')}</Text>
            <View style={styles.langRow}>
              <TouchableOpacity
                style={[styles.langBtn, i18n.language === 'fr' && styles.langBtnActive]}
                onPress={() => i18n.changeLanguage('fr')}>
                <Text style={[styles.langBtnText, i18n.language === 'fr' && styles.langBtnTextActive]}>
                  Français
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.langBtn, i18n.language === 'en' && styles.langBtnActive]}
                onPress={() => i18n.changeLanguage('en')}>
                <Text style={[styles.langBtnText, i18n.language === 'en' && styles.langBtnTextActive]}>
                  English
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={logout}>
          <Text style={styles.logoutText}>{t('profile.logout')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({ label, value }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value || '—'}</Text>
    </View>
  );
}

function makeStyles(c) {
  return StyleSheet.create({
    pageTitle: { fontSize: 22, fontWeight: '700', color: c.gray900, marginBottom: spacing.lg },
    avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: c.teal600, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
    avatarText: { fontSize: 24, fontWeight: '700', color: '#ffffff' },
    name:       { fontSize: 18, fontWeight: '600', color: c.gray900 },
    email:      { fontSize: 13, color: c.gray500, marginTop: 2 },
    roleBadge:  { marginTop: spacing.sm, backgroundColor: c.teal50, paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.full },
    roleText:   { fontSize: 12, color: c.teal700, fontWeight: '500' },
    memberBadge: { marginTop: 6, backgroundColor: c.teal50, borderWidth: 1, borderColor: c.teal200, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999 },
    memberText:  { fontSize: 12, color: c.teal700, fontWeight: '700', fontVariant: ['tabular-nums'] },
    infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.gray200 },
    infoLabel: { fontSize: 13, color: c.gray500 },
    infoValue: { fontSize: 13, color: c.gray800, fontWeight: '500', flexShrink: 1, textAlign: 'right', marginLeft: spacing.md },
    langRow:          { flexDirection: 'row', gap: spacing.sm },
    langBtn:          { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: c.gray300, alignItems: 'center' },
    langBtnActive:    { backgroundColor: c.teal600, borderColor: c.teal600 },
    langBtnText:      { fontSize: 14, color: c.gray700, fontWeight: '500' },
    langBtnTextActive:{ color: '#ffffff', fontWeight: '700' },
    logoutBtn:  { marginTop: spacing.xl, backgroundColor: c.red500, borderRadius: 12, paddingVertical: spacing.md, alignItems: 'center' },
    logoutText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
  });
}
