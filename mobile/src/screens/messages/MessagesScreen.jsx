/**
 * MessagesScreen — conversations list + thread in one component.
 *
 * view === 'list' : shows all trip conversations (newest first)
 * view === 'chat' : shows the full thread for the selected trip
 *
 * The screen accepts route params { tripId, tripNumber, otherName }
 * to jump directly into a chat (e.g. from a trip tile's Chat button).
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useMessages } from '../../context/MessagesContext';
import { messageService } from '../../services/api';
import { useColors, useShared, spacing, radius } from '../../theme';

// ── Helpers ────────────────────────────────────────────────────────────────────

// Client-side copy of backend namePrivacy.maskName.
// clients and drivers see "FirstName L."; operators/admins see the full name.
// Keep this in sync with backend/src/utils/namePrivacy.js.
function maskName(first, last, viewerRole) {
  if (!first && !last) return '';
  const privateRoles = new Set(['client', 'driver']);
  if (privateRoles.has(viewerRole) && last) return `${first} ${last[0].toUpperCase()}.`;
  return `${first} ${last}`.trim();
}

function fmtConvDate(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  const diffDays = Math.floor((new Date() - d) / 86400000);
  const locale = lang === 'fr' ? 'fr-CA' : 'en-CA';
  if (diffDays === 0) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return lang === 'fr' ? 'Hier' : 'Yesterday';
  if (diffDays < 7)  return d.toLocaleDateString(locale, { weekday: 'short' });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

function fmtMsgDate(iso, lang) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MessagesScreen() {
  const { t, i18n }        = useTranslation();
  const { user }           = useAuth();
  const { refreshUnread }  = useMessages();
  const c      = useColors();
  const sh     = useShared();
  const styles = useMemo(() => makeStyles(c), [c]);
  const route              = useRoute();

  // view: 'list' or 'chat'
  const [view,      setView]      = useState('list');
  const [chatTrip,  setChatTrip]  = useState(null); // { tripId, tripNumber, otherName }

  // ── List state ───────────────────────────────────────────────────────────────
  const [convs,   setConvs]   = useState([]);
  const [listLoading, setListLoading] = useState(true);

  // ── Chat state ───────────────────────────────────────────────────────────────
  const [trip,       setTrip]       = useState(null);
  const [messages,   setMessages]   = useState([]);
  const [windowOpen, setWindowOpen] = useState(true);
  const [windowDays, setWindowDays] = useState(30);
  const [chatLoading,setChatLoading]= useState(false);
  const [body,       setBody]       = useState('');
  const [sending,    setSending]    = useState(false);
  const [sendError,  setSendError]  = useState('');

  // ── React to route params (e.g. Chat button on a trip tile) ──────────────────

  useEffect(() => {
    const { tripId, tripNumber, otherName } = route.params ?? {};
    if (tripId) {
      openChat({ tripId, tripNumber, otherName });
    }
  }, [route.params?.tripId, route.params?.ts]);

  // ── Load conversations (refresh whenever screen gains focus) ─────────────────

  const loadConvs = useCallback(() => {
    setListLoading(true);
    messageService.conversations()
      .then(({ data }) => setConvs(data.conversations || []))
      .catch(() => setConvs([]))
      .finally(() => setListLoading(false));
    refreshUnread();
  }, [refreshUnread]);

  useFocusEffect(useCallback(() => {
    if (view === 'list') loadConvs();
  }, [view, loadConvs]));

  // ── Load thread ──────────────────────────────────────────────────────────────

  const loadThread = useCallback((tripId) => {
    return messageService.thread(tripId)
      .then(({ data }) => {
        setTrip(data.trip);
        setMessages(data.messages || []);
        setWindowOpen(data.window_open);
        setWindowDays(data.window_days ?? 30);
        refreshUnread();
      })
      .catch(() => {});
  }, [refreshUnread]);

  function openChat(params) {
    setChatTrip(params);
    setBody('');
    setSendError('');
    setChatLoading(true);
    setView('chat');
    loadThread(params.tripId).finally(() => setChatLoading(false));
  }

  function goBack() {
    setView('list');
    loadConvs();
  }

  // ── Send message ─────────────────────────────────────────────────────────────

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (trimmed.length > 500) { setSendError(t('messages.error_too_long')); return; }
    setSendError('');
    setSending(true);
    try {
      await messageService.send(chatTrip.tripId, trimmed);
      setBody('');
      await loadThread(chatTrip.tripId);
    } catch (err) {
      const code = err?.response?.data?.code;
      setSendError(code === 'WINDOW_CLOSED'
        ? t('messages.error_window_closed')
        : t('common.error'));
    } finally {
      setSending(false);
    }
  }

  // ── Helpers for display ───────────────────────────────────────────────────────

  function otherParty(conv) {
    if (user?.role === 'driver')
      return conv.client_first
        ? maskName(conv.client_first, conv.client_last, user?.role)
        : t('messages.unknown_client');
    return conv.driver_first
      ? maskName(conv.driver_first, conv.driver_last, user?.role)
      : t('messages.no_driver');
  }

  const remaining = 500 - body.length;

  // ── Render: conversations list ────────────────────────────────────────────────

  if (view === 'list') {
    return (
      <SafeAreaView style={sh.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('messages.title')}</Text>
        </View>

        {listLoading ? (
          <ActivityIndicator color={c.teal600} style={{ marginTop: 40 }} />
        ) : convs.length === 0 ? (
          <View style={styles.empty}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>💬</Text>
            <Text style={styles.emptyText}>{t('messages.no_conversations')}</Text>
          </View>
        ) : (
          <FlatList
            data={convs}
            keyExtractor={item => String(item.trip_id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => {
              const unread = parseInt(item.unread_count || 0);
              const isMine = item.last_sender_id === user?.id;
              return (
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.7}
                  onPress={() => openChat({
                    tripId:     item.trip_id,
                    tripNumber: item.trip_number,
                    otherName:  otherParty(item),
                  })}
                >
                  <View style={[styles.avatar, unread > 0 && styles.avatarUnread]}>
                    <Text style={{ fontSize: 18 }}>💬</Text>
                  </View>
                  <View style={styles.rowContent}>
                    <View style={styles.rowTop}>
                      <Text style={[styles.rowName, unread > 0 && styles.rowNameBold]}
                            numberOfLines={1}>
                        {otherParty(item)}
                      </Text>
                      <Text style={styles.rowTime}>
                        {fmtConvDate(item.last_created_at, i18n.language)}
                      </Text>
                    </View>
                    <View style={styles.rowBottom}>
                      <Text style={styles.rowPreview} numberOfLines={1}>
                        <Text style={styles.tripBadgeText}>T-{item.trip_number}  </Text>
                        {isMine && <Text style={styles.checkmark}>✓ </Text>}
                        {item.last_body}
                      </Text>
                      {unread > 0 && (
                        <View style={styles.unreadBadge}>
                          <Text style={styles.unreadBadgeText}>
                            {unread > 9 ? '9+' : unread}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </SafeAreaView>
    );
  }

  // ── Render: chat thread ───────────────────────────────────────────────────────

  return (
    <SafeAreaView style={sh.screen}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.tripBadge}>T-{chatTrip?.tripNumber}</Text>
            <Text style={styles.headerName} numberOfLines={1}>
              {chatTrip?.otherName}
            </Text>
          </View>
          {trip && (
            <Text style={styles.headerRoute} numberOfLines={1}>
              {trip.pickup_address} → {trip.dropoff_address}
            </Text>
          )}
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {chatLoading ? (
          <ActivityIndicator color={c.teal600} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Closed window banner */}
            {!windowOpen && (
              <View style={styles.closedBanner}>
                <Text style={styles.closedText}>
                  🔒 {t('messages.window_closed', { days: windowDays })}
                </Text>
              </View>
            )}

            {/* Send form */}
            {windowOpen && (
              <View style={styles.sendBox}>
                <TextInput
                  style={styles.input}
                  value={body}
                  onChangeText={text => { setBody(text); setSendError(''); }}
                  placeholder={t('messages.send_placeholder')}
                  placeholderTextColor={c.gray400}
                  multiline
                  maxLength={500}
                  editable={!sending}
                />
                <View style={styles.sendFooter}>
                  <Text style={[styles.charCount, remaining < 50 && styles.charCountWarn]}>
                    {t('messages.chars_remaining', { count: remaining })}
                  </Text>
                  <TouchableOpacity
                    style={[styles.sendBtn, (!body.trim() || sending) && styles.sendBtnDisabled]}
                    onPress={handleSend}
                    disabled={!body.trim() || sending}
                    activeOpacity={0.8}
                  >
                    {sending
                      ? <ActivityIndicator size="small" color={c.white} />
                      : <Text style={styles.sendBtnText}>{t('messages.send_button')}</Text>}
                  </TouchableOpacity>
                </View>
                {!!sendError && <Text style={styles.errorText}>{sendError}</Text>}
              </View>
            )}

            {/* Message list */}
            {messages.length === 0 ? (
              <View style={styles.empty}>
                <Text style={{ fontSize: 32, marginBottom: 8 }}>💬</Text>
                <Text style={styles.emptyText}>{t('messages.no_messages')}</Text>
              </View>
            ) : (
              <FlatList
                data={messages}
                keyExtractor={item => String(item.id)}
                contentContainerStyle={styles.msgList}
                renderItem={({ item: msg }) => {
                  const isMine = msg.sender_id === user?.id;
                  return (
                    <View style={[styles.msgRow, isMine ? styles.msgRowMine : styles.msgRowOther]}>
                      {!isMine && (
                        <View style={styles.msgAvatar}>
                          <Text style={styles.msgAvatarText}>
                            {(msg.first_name?.[0] || '?').toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <View style={[styles.msgGroup,
                        isMine ? styles.msgGroupMine : styles.msgGroupOther]}>
                        <View style={[styles.msgMeta, isMine && styles.msgMetaReverse]}>
                          <Text style={styles.msgSender}>
                            {isMine ? t('messages.you') : maskName(msg.first_name, msg.last_name, user?.role)}
                          </Text>
                          <Text style={styles.msgTime}>
                            {fmtMsgDate(msg.created_at, i18n.language)}
                          </Text>
                        </View>
                        <View style={[styles.bubble,
                          isMine ? styles.bubbleMine : styles.bubbleOther]}>
                          <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>
                            {msg.body}
                          </Text>
                        </View>
                        {isMine && msg.read_at && (
                          <Text style={styles.readReceipt}>✓✓</Text>
                        )}
                      </View>
                      {isMine && <View style={{ width: 36 }} />}
                    </View>
                  );
                }}
              />
            )}
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

function makeStyles(c) {
  return StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.gray200,
    backgroundColor: c.surface,
    gap: spacing.md,
  },
  title:      { fontSize: 20, fontWeight: '700', color: c.gray900 },
  backBtn:    { paddingRight: spacing.sm },
  backText:   { fontSize: 22, color: c.gray600 },
  tripBadge:  {
    fontSize: 11, fontWeight: '700', color: c.white,
    backgroundColor: c.gray500, borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  headerName:  { fontSize: 14, fontWeight: '600', color: c.gray900, flexShrink: 1 },
  headerRoute: { fontSize: 11, color: c.gray400, marginTop: 1 },

  // Conversation list
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: c.gray100,
    backgroundColor: c.surface,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: c.gray100,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.md, flexShrink: 0,
  },
  avatarUnread: { backgroundColor: c.teal100 },
  rowContent:   { flex: 1, minWidth: 0 },
  rowTop:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  rowName:      { fontSize: 14, color: c.gray700, flexShrink: 1 },
  rowNameBold:  { fontWeight: '700', color: c.gray900 },
  rowTime:      { fontSize: 11, color: c.gray400, flexShrink: 0, marginLeft: 6 },
  rowBottom:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowPreview:   { fontSize: 12, color: c.gray400, flex: 1 },
  tripBadgeText:{ color: c.gray500 },
  checkmark:    { color: c.gray300 },
  unreadBadge:  {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: c.teal600,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 6, flexShrink: 0,
  },
  unreadBadgeText: { fontSize: 11, color: c.white, fontWeight: '700' },
  chevron:      { fontSize: 18, color: c.gray300, marginLeft: spacing.sm },

  // Empty state
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: spacing.xl, paddingBottom: 60,
  },
  emptyText: { fontSize: 13, color: c.gray400, textAlign: 'center', lineHeight: 20 },

  // Closed banner
  closedBanner: {
    marginHorizontal: spacing.lg, marginTop: spacing.md,
    backgroundColor: '#fffbeb', borderColor: '#fde68a',
    borderWidth: 1, borderRadius: radius.md, padding: spacing.md,
  },
  closedText: { fontSize: 13, color: '#92400e' },

  // Send box
  sendBox: {
    marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.sm,
    backgroundColor: c.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: c.gray200, padding: spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, elevation: 1,
  },
  input: {
    minHeight: 72, maxHeight: 140,
    fontSize: 14, color: c.gray900, textAlignVertical: 'top', paddingTop: 0,
  },
  sendFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing.sm, paddingTop: spacing.sm,
    borderTopWidth: 1, borderTopColor: c.gray100,
  },
  charCount:     { fontSize: 11, color: c.gray400 },
  charCountWarn: { color: '#d97706', fontWeight: '600' },
  sendBtn: {
    backgroundColor: c.teal600, borderRadius: radius.md,
    paddingVertical: 8, paddingHorizontal: spacing.lg,
    minWidth: 80, alignItems: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText:     { color: c.white, fontWeight: '600', fontSize: 14 },
  errorText:       { fontSize: 12, color: c.red500, marginTop: spacing.xs },

  // Message thread
  msgList: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  msgRow:  { flexDirection: 'row', alignItems: 'flex-end', marginBottom: spacing.md },
  msgRowMine:  { justifyContent: 'flex-end' },
  msgRowOther: { justifyContent: 'flex-start' },
  msgAvatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: c.gray200,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm, flexShrink: 0,
  },
  msgAvatarText: { fontSize: 12, fontWeight: '700', color: c.gray600 },
  msgGroup:      { maxWidth: '75%', gap: 3 },
  msgGroupMine:  { alignItems: 'flex-end' },
  msgGroupOther: { alignItems: 'flex-start' },
  msgMeta:        { flexDirection: 'row', alignItems: 'center', gap: 6 },
  msgMetaReverse: { flexDirection: 'row-reverse' },
  msgSender: { fontSize: 11, fontWeight: '600', color: c.gray700 },
  msgTime:   { fontSize: 10, color: c.gray400 },
  bubble:    { borderRadius: 18, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleMine:      { backgroundColor: c.teal600, borderBottomRightRadius: 4 },
  bubbleOther:     { backgroundColor: c.gray100, borderBottomLeftRadius: 4 },
  bubbleText:      { fontSize: 14, color: c.gray900, lineHeight: 20 },
  bubbleTextMine:  { color: c.white },
  readReceipt:     { fontSize: 10, color: c.gray400, marginTop: 1 },
  });
}
