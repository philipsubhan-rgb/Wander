import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { getBaseUrl } from '@/lib/api';

export default function ForgotPasswordScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const isWeb = Platform.OS === 'web';

  const [email, setEmail] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return;
    setIsPending(true);
    try {
      await fetch(`${getBaseUrl()}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });
      // Always show success to avoid email enumeration
      setSubmitted(true);
    } catch {
      // Still show success to avoid enumeration
      setSubmitted(true);
    } finally {
      setIsPending(false);
    }
  }

  const styles = makeStyles(colors, insets, isWeb);

  return (
    <>
      <Stack.Screen options={{ title: 'Forgot Password', headerShown: false }} />
      <View style={styles.container}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Back button */}
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => router.back()}
              hitSlop={8}
            >
              <Feather name="arrow-left" size={20} color="rgba(255,255,255,0.9)" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>

            {/* Logo area */}
            <View style={styles.logoArea}>
              <View style={styles.iconCircle}>
                <Feather name="lock" size={32} color="#fff" />
              </View>
              <Text style={styles.screenTitle}>Forgot Password</Text>
              <Text style={styles.tagline}>
                Enter your email and we'll send you a reset link.
              </Text>
            </View>

            {/* Form */}
            <View style={styles.form}>
              {submitted ? (
                /* Success state */
                <View style={styles.successBox}>
                  <View style={[styles.successIconWrap, { backgroundColor: '#10B98120' }]}>
                    <Feather name="check-circle" size={32} color="#10B981" />
                  </View>
                  <Text style={[styles.successTitle, { color: colors.foreground }]}>
                    Check your email
                  </Text>
                  <Text style={[styles.successSub, { color: colors.mutedForeground }]}>
                    If an account exists for {email.trim().toLowerCase()}, you'll receive a password reset link shortly.
                  </Text>
                  <TouchableOpacity
                    style={[styles.backToLoginBtn, { backgroundColor: colors.primary }]}
                    onPress={() => router.replace('/login')}
                    activeOpacity={0.85}
                  >
                    <Feather name="arrow-left" size={15} color="#fff" />
                    <Text style={styles.backToLoginText}>Back to Sign In</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                /* Input state */
                <>
                  <View style={styles.field}>
                    <Text style={styles.label}>Email Address</Text>
                    <View style={styles.inputWrap}>
                      <Feather
                        name="mail"
                        size={16}
                        color={colors.mutedForeground}
                        style={styles.inputIcon}
                      />
                      <TextInput
                        style={styles.input}
                        placeholder="Enter your email address"
                        placeholderTextColor={colors.mutedForeground}
                        value={email}
                        onChangeText={setEmail}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        textContentType="emailAddress"
                        returnKeyType="done"
                        onSubmitEditing={handleSubmit}
                        testID="forgot-email-input"
                      />
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[styles.submitBtn, (!email.trim() || isPending) && styles.submitBtnDisabled]}
                    onPress={handleSubmit}
                    disabled={!email.trim() || isPending}
                    activeOpacity={0.85}
                    testID="forgot-submit-button"
                  >
                    {isPending ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.submitBtnText}>Send Reset Link</Text>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => router.back()}
                    activeOpacity={0.7}
                    style={styles.cancelBtn}
                  >
                    <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>
                      Remember your password? Sign in
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </>
  );
}

function makeStyles(
  colors: ReturnType<typeof useColors>,
  insets: { top: number; bottom: number },
  isWeb: boolean,
) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.primary,
    },
    scroll: {
      flexGrow: 1,
      paddingTop: isWeb ? insets.top + 67 : insets.top + 20,
      paddingBottom: isWeb ? insets.bottom + 34 : insets.bottom + 24,
      paddingHorizontal: 24,
    },
    backBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 8,
      alignSelf: 'flex-start',
      marginBottom: 16,
    },
    backText: {
      color: 'rgba(255,255,255,0.9)',
      fontSize: 15,
      fontFamily: 'Inter_500Medium',
    },
    logoArea: {
      alignItems: 'center',
      marginBottom: 36,
    },
    iconCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
    },
    screenTitle: {
      fontSize: 28,
      fontWeight: '700' as const,
      color: '#fff',
      fontFamily: 'Inter_700Bold',
      letterSpacing: -0.5,
    },
    tagline: {
      fontSize: 14,
      color: 'rgba(255,255,255,0.75)',
      fontFamily: 'Inter_400Regular',
      marginTop: 6,
      textAlign: 'center',
    },
    form: {
      backgroundColor: colors.card,
      borderRadius: colors.radius * 1.5,
      padding: 24,
      gap: 16,
    },
    field: {
      gap: 6,
    },
    label: {
      fontSize: 13,
      fontFamily: 'Inter_600SemiBold',
      color: colors.foreground,
    },
    inputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.background,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 12,
      gap: 8,
    },
    inputIcon: {
      marginRight: 2,
    },
    input: {
      flex: 1,
      fontSize: 15,
      color: colors.foreground,
      fontFamily: 'Inter_400Regular',
      padding: 0,
      margin: 0,
    },
    submitBtn: {
      backgroundColor: colors.primary,
      borderRadius: colors.radius,
      paddingVertical: 15,
      alignItems: 'center',
      marginTop: 4,
    },
    submitBtnDisabled: {
      opacity: 0.5,
    },
    submitBtnText: {
      color: '#fff',
      fontSize: 15,
      fontFamily: 'Inter_600SemiBold',
    },
    cancelBtn: {
      alignItems: 'center',
      paddingVertical: 4,
    },
    cancelText: {
      fontSize: 13,
      fontFamily: 'Inter_400Regular',
    },
    successBox: {
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
    },
    successIconWrap: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 4,
    },
    successTitle: {
      fontSize: 20,
      fontFamily: 'Inter_700Bold',
    },
    successSub: {
      fontSize: 14,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
      lineHeight: 20,
    },
    backToLoginBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: colors.radius,
      marginTop: 8,
    },
    backToLoginText: {
      color: '#fff',
      fontSize: 15,
      fontFamily: 'Inter_600SemiBold',
    },
  });
}
