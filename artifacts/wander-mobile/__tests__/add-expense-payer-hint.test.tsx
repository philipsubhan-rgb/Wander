/**
 * Tests for the payer hint in AddExpenseScreen:
 *  - hint is visible when participants are loaded but no payer is selected
 *  - hint disappears after tapping a participant chip
 *  - Save button is disabled while the hint is visible; it becomes
 *    enabled once amount, description, and payer are all provided
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// ─── Module mocks (must be declared before any import of the module) ─────────

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ tripId: '1' }),
  router: { back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text>{name}</Text>,
  };
});

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  notificationAsync: jest.fn(),
  impactAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: jest.fn(),
    invalidateQueries: jest.fn(),
  }),
}));

// Auth: start with no logged-in user so paidByUserId initialises to null
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    background: '#fff',
    foreground: '#000',
    card: '#fff',
    cardForeground: '#000',
    primary: '#2F7CE0',
    primaryForeground: '#fff',
    muted: '#eee',
    mutedForeground: '#888',
    border: '#ddd',
    destructive: '#f00',
    radius: 8,
  }),
}));

// DatePickerField — render a stub so we don't pull in native modules
jest.mock('@/components/DatePickerField', () => {
  const { View } = require('react-native');
  return { DatePickerField: () => <View testID="date-picker-stub" /> };
});

// Participants returned by the API
const PARTICIPANTS = [
  { id: 10, name: 'Alice Smith', email: 'alice@example.com' },
  { id: 11, name: 'Bob Jones', email: 'bob@example.com' },
];

// api-client-react mock (moduleNameMapper points here)
import {
  useListTripParticipants,
  useCreateExpense,
} from '@workspace/api-client-react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockedUseListTripParticipants = useListTripParticipants as jest.Mock;
const mockedUseCreateExpense = useCreateExpense as jest.Mock;

function setupMocks(participantOverride?: unknown[] | null) {
  mockedUseListTripParticipants.mockReturnValue({
    data: participantOverride === undefined ? PARTICIPANTS : participantOverride,
  });
  mockedUseCreateExpense.mockReturnValue({ mutate: jest.fn(), isPending: false });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Import the component under test after all jest.mock() calls
// eslint-disable-next-line import/first
import AddExpenseScreen from '../app/add-expense/[tripId]';

describe('AddExpenseScreen — payer hint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the hint when participants are loaded and no payer is selected', () => {
    setupMocks();

    const { getByText } = render(<AddExpenseScreen />);

    expect(
      getByText('Select who paid above before saving.'),
    ).toBeTruthy();
  });

  it('hides the hint after tapping a participant chip', () => {
    setupMocks();

    const { getByText, queryByText } = render(<AddExpenseScreen />);

    // Hint is initially visible
    expect(getByText('Select who paid above before saving.')).toBeTruthy();

    // Tap the first participant chip (shows first name only)
    fireEvent.press(getByText('Alice'));

    // Hint must be gone
    expect(queryByText('Select who paid above before saving.')).toBeNull();
  });

  it('keeps the Save button disabled while the hint is visible', () => {
    setupMocks();

    const { getByTestId } = render(<AddExpenseScreen />);

    const saveBtn = getByTestId('submit-expense');
    expect(saveBtn.props.accessibilityState?.disabled ?? saveBtn.props.disabled).toBeTruthy();
  });

  it('enables the Save button once amount, description, and payer are all set', () => {
    setupMocks();

    const { getByTestId, getByText, getByPlaceholderText } = render(
      <AddExpenseScreen />,
    );

    // Enter an amount via the numpad
    fireEvent.press(getByTestId('pad-5'));

    // Fill description
    fireEvent.changeText(
      getByPlaceholderText('e.g. Dinner at Nobu'),
      'Team dinner',
    );

    // Select a payer
    fireEvent.press(getByText('Alice'));

    // Save button should now be enabled
    const saveBtn = getByTestId('submit-expense');
    const isDisabled =
      saveBtn.props.accessibilityState?.disabled ?? saveBtn.props.disabled;
    expect(isDisabled).toBeFalsy();
  });

  it('does not show the hint when participants list is empty', () => {
    setupMocks([]);

    const { queryByText } = render(<AddExpenseScreen />);

    expect(queryByText('Select who paid above before saving.')).toBeNull();
  });
});
