import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Alert,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';
import { getBaseUrl } from '@/lib/api';

function UserAvatar({ name, size, colors }: {
  name: string;
  size: number;
  colors: ReturnType<typeof useColors>;
}) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <View
      style={[
        avatarStyles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primary },
      ]}
    >
      <Text style={[avatarStyles.initials, { fontSize: size * 0.38, color: colors.primaryForeground }]}>
        {initials}
      </Text>
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontFamily: 'Inter_700Bold' },
});

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const isWeb = Platform.OS === 'web';
  const [loggingOut, setLoggingOut] = useState(false);

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const topPad = isWeb ? insets.top + 67 : insets.top;

  if (!user) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  function confirmLogout() {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: handleLogout,
      },
    ]);
  }

  async function handleLogout() {
    setLoggingOut(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await logout();
      router.replace('/login');
    } catch {
      setLoggingOut(false);
    }
  }

  async function handleChangePassword() {
    if (!currentPassword.trim() || !newPassword.trim() || !confirmPassword.trim()) {
      Alert.alert('Missing fields', 'Please fill in all password fields.');
      return;
    }
    if (newPassword.length < 8) {
      Alert.alert('Weak password', 'New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Mismatch', 'New password and confirmation do not match.');
      return;
    }

    setIsChangingPassword(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        throw new Error('Failed');
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'Password changed successfully.');
    } catch {
      Alert.alert('Error', 'Failed to change password. Check your current password.');
    } finally {
      setIsChangingPassword(false);
    }
  }

  const roleLabel = user.role === 'admin' ? 'Trip Admin' : 'Traveler';
  const roleColor = user.role === 'admin' ? colors.primary : '#10B981';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Profile</Text>
        </View>

        {/* Avatar section */}
        <View style={styles.avatarSection}>
          <UserAvatar name={user.name} size={80} colors={colors} />
          <Text style={[styles.name, { color: colors.foreground }]}>{user.name}</Text>
          <View style={[styles.roleBadge, { backgroundColor: roleColor + '20' }]}>
            <Text style={[styles.roleText, { color: roleColor }]}>{roleLabel}</Text>
          </View>
        </View>

        {/* Info card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <InfoRow icon="user" label="Username" value={`@${user.username}`} colors={colors} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          {user.email ? (
            <>
              <InfoRow icon="mail" label="Email" value={user.email} colors={colors} />
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
            </>
          ) : null}
          <InfoRow icon="shield" label="Role" value={roleLabel} colors={colors} />
        </View>

        {/* Change Password section */}
        <View style={styles.sectionHeader}>
          <Feather name="lock" size={14} color={colors.mutedForeground} />
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>Change Password</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Current Password */}
          <View style={styles.pwField}>
            <Text style={[styles.pwLabel, { color: colors.mutedForeground }]}>Current Password</Text>
            <View style={[styles.pwInputWrap, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Feather name="lock" size={15} color={colors.mutedForeground} />
              <TextInput
                style={[styles.pwInput, { color: colors.foreground }]}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Enter current password"
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry={!showCurrent}
                autoCapitalize="none"
                testID="current-password-input"
              />
              <TouchableOpacity onPress={() => setShowCurrent(v => !v)} hitSlop={8}>
                <Feather name={showCurrent ? 'eye-off' : 'eye'} size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          {/* New Password */}
          <View style={styles.pwField}>
            <Text style={[styles.pwLabel, { color: colors.mutedForeground }]}>New Password</Text>
            <View style={[styles.pwInputWrap, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Feather name="key" size={15} color={colors.mutedForeground} />
              <TextInput
                style={[styles.pwInput, { color: colors.foreground }]}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="Min. 8 characters"
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry={!showNew}
                autoCapitalize="none"
                testID="new-password-input"
              />
              <TouchableOpacity onPress={() => setShowNew(v => !v)} hitSlop={8}>
                <Feather name={showNew ? 'eye-off' : 'eye'} size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          {/* Confirm New Password */}
          <View style={styles.pwField}>
            <Text style={[styles.pwLabel, { color: colors.mutedForeground }]}>Confirm New Password</Text>
            <View style={[styles.pwInputWrap, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Feather name="check-circle" size={15} color={colors.mutedForeground} />
              <TextInput
                style={[styles.pwInput, { color: colors.foreground }]}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Re-enter new password"
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry={!showConfirm}
                autoCapitalize="none"
                testID="confirm-password-input"
              />
              <TouchableOpacity onPress={() => setShowConfirm(v => !v)} hitSlop={8}>
                <Feather name={showConfirm ? 'eye-off' : 'eye'} size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.changePasswordBtn, { backgroundColor: colors.primary }, isChangingPassword && styles.btnDisabled]}
          onPress={handleChangePassword}
          disabled={isChangingPassword}
          activeOpacity={0.85}
          testID="change-password-button"
        >
          {isChangingPassword ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Feather name="lock" size={15} color="#fff" />
              <Text style={styles.changePasswordBtnText}>Update Password</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Logout */}
        <TouchableOpacity
          style={[styles.logoutBtn, { borderColor: colors.destructive }]}
          onPress={confirmLogout}
          disabled={loggingOut}
          activeOpacity={0.8}
          testID="logout-button"
        >
          {loggingOut ? (
            <ActivityIndicator color={colors.destructive} size="small" />
          ) : (
            <>
              <Feather name="log-out" size={16} color={colors.destructive} />
              <Text style={[styles.logoutText, { color: colors.destructive }]}>Sign Out</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function InfoRow({
  icon,
  label,
  value,
  colors,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.infoRow}>
      <View style={[styles.infoIconWrap, { backgroundColor: colors.muted }]}>
        <Feather name={icon} size={14} color={colors.primary} />
      </View>
      <View style={styles.infoContent}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: colors.foreground }]}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
  },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: 28,
    gap: 10,
  },
  name: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
  },
  roleBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
  },
  roleText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  infoIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoContent: { flex: 1, gap: 2 },
  infoLabel: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  infoValue: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 20,
    marginTop: 24,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  pwField: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  pwLabel: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
  pwInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pwInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    padding: 0,
    margin: 0,
  },
  changePasswordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 12,
  },
  changePasswordBtnText: {
    color: '#fff',
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 16,
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  logoutText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
