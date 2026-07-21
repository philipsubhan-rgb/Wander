/**
 * DatePickerField
 *
 * On native: tappable row that opens a DateTimePicker modal.
 * On web:    a styled <input type="date"> (browser-native date picker).
 *
 * Props:
 *   value    – ISO date string "YYYY-MM-DD" (empty string = no date selected)
 *   onChange – called with a new ISO date string "YYYY-MM-DD"
 *   colors   – theme colours from useColors()
 */
import React, { useState } from 'react';
import {
  Platform,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';

interface DatePickerFieldProps {
  value: string; // "YYYY-MM-DD" or ""
  onChange: (iso: string) => void;
  colors: {
    card: string;
    border: string;
    foreground: string;
    mutedForeground: string;
    primary: string;
  };
  testID?: string;
}

/** "2026-07-21" → Date (local midnight) */
function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Date → "YYYY-MM-DD" */
function dateToIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "2026-07-21" → "Jul 21, 2026" */
function isoToDisplay(iso: string): string {
  if (!iso) return '';
  try {
    const date = isoToDate(iso);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function DatePickerField({ value, onChange, colors, testID }: DatePickerFieldProps) {
  const [showPicker, setShowPicker] = useState(false);

  const currentDate = value ? isoToDate(value) : new Date();

  // ── Web ────────────────────────────────────────────────────────────────────
  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.inputWrap,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {/* @ts-ignore – web-only input element */}
        <input
          type="date"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 15,
            fontFamily: 'Inter_400Regular, Inter, sans-serif',
            color: value ? colors.foreground : colors.mutedForeground,
            width: '100%',
            padding: 0,
            margin: 0,
            cursor: 'pointer',
          }}
          data-testid={testID}
        />
      </View>
    );
  }

  // ── Native (iOS / Android) ─────────────────────────────────────────────────
  return (
    <>
      <TouchableOpacity
        style={[
          styles.inputWrap,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
        onPress={() => setShowPicker(true)}
        activeOpacity={0.7}
        testID={testID}
      >
        <View style={styles.row}>
          <Text
            style={[
              styles.dateText,
              { color: value ? colors.foreground : colors.mutedForeground },
            ]}
          >
            {value ? isoToDisplay(value) : 'Select a date'}
          </Text>
          <Feather name="calendar" size={16} color={colors.mutedForeground} />
        </View>
      </TouchableOpacity>

      {showPicker && (
        <DateTimePicker
          value={currentDate}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
            // On Android the picker closes itself; on iOS we keep it open
            if (Platform.OS === 'android') {
              setShowPicker(false);
            }
            if (event.type === 'set' && selectedDate) {
              onChange(dateToIso(selectedDate));
              if (Platform.OS === 'ios') setShowPicker(false);
            } else if (event.type === 'dismissed') {
              setShowPicker(false);
            }
          }}
          maximumDate={new Date(2100, 11, 31)}
          minimumDate={new Date(2000, 0, 1)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  inputWrap: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
});
