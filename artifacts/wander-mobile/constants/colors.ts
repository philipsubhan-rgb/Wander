/**
 * Wander Mobile — design tokens synced from the web app's Blue Ocean theme.
 * HSL values from artifacts/trip-planner/src/index.css → converted to hex.
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#172040',
    tint: '#2F7CE0',

    background: '#F4F7FE',
    foreground: '#172040',

    card: '#FFFFFF',
    cardForeground: '#172040',

    primary: '#2F7CE0',
    primaryForeground: '#FFFFFF',

    secondary: '#C9DAFB',
    secondaryForeground: '#172040',

    muted: '#E3ECFB',
    mutedForeground: '#6B7FA3',

    accent: '#E3ECFB',
    accentForeground: '#172040',

    destructive: '#CC3333',
    destructiveForeground: '#FFFFFF',

    border: '#D2DDEF',
    input: '#D2DDEF',
  },

  dark: {
    text: '#E8EFF9',
    tint: '#5194F0',

    background: '#0D1829',
    foreground: '#E8EFF9',

    card: '#122038',
    cardForeground: '#E8EFF9',

    primary: '#5194F0',
    primaryForeground: '#FFFFFF',

    secondary: '#1A3257',
    secondaryForeground: '#E8EFF9',

    muted: '#172845',
    mutedForeground: '#7A97C0',

    accent: '#172845',
    accentForeground: '#E8EFF9',

    destructive: '#E05050',
    destructiveForeground: '#FFFFFF',

    border: '#233A5A',
    input: '#233A5A',
  },

  /** Border radius in px (web uses --radius: 0.5rem = 8px) */
  radius: 12,
};

export default colors;
