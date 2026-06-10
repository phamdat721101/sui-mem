import type { Config } from 'tailwindcss';

/**
 * openx — design tokens for the OpenX Sui-native marketplace.
 *
 * Dark-mode only. Primary = X-Blue cyan. Secondary = Matrix-Green.
 * Same palette as the previous version so brand identity carries forward.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        background: '#131314',
        surface: '#201f20',
        'surface-container-low': '#1c1b1c',
        'surface-container-high': '#2a2a2b',
        primary: '#00f0ff',
        'primary-container': '#00f0ff',
        'on-primary': '#00363a',
        'primary-text': '#dbfcff',
        secondary: '#13ff43',
        tertiary: '#d1bcff',
        error: '#ffb4ab',
        'on-surface': '#e5e2e3',
        'on-surface-variant': '#b9cacb',
        outline: '#849495',
        'outline-variant': '#3b494b',
      },
      fontFamily: {
        headline: ['Geist', 'system-ui', 'sans-serif'],
        body: ['Geist', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: '2px',
        DEFAULT: '4px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        'glow-cyan': '0 0 24px rgba(0, 240, 255, 0.18)',
        'glow-green': '0 0 24px rgba(19, 255, 67, 0.18)',
      },
    },
  },
  plugins: [],
};

export default config;
