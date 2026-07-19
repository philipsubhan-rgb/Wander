import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

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

  const roleLabel = user.role === 'admin' ? 'Trip Admin' : 'Traveler';
  const roleColor = user.role === 'admin' ? colors.primary : '#10B981';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
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
    </View>
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
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 16,
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  logoutText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
