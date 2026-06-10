/**
 * Design tokens — single source of truth for FHE Second Brain v1.0.
 *
 * Values aligned with `new-ui/fhe_second_brain/DESIGN.md` and `docs/DESIGN_BRIEF.md`.
 * Consumed by:
 *   - `tailwind-preset.ts` → Tailwind theme.extend
 *   - React components in `primitives.tsx` / `molecules.tsx` (via Tailwind classes)
 *
 * SOLID — Single Responsibility: this file declares values only, no logic.
 */

export const colors = {
  // Backgrounds (tonal layering for depth)
  background: '#0c1324',
  surface: '#0F172A',
  'surface-bright': '#33394c',
  'surface-container': '#191f31',
  'surface-container-low': '#151b2d',
  'surface-container-high': '#23293c',
  'surface-container-highest': '#2e3447',

  // Card surface (Layer 2)
  card: '#1E293B',
  border: '#334155',

  // Brand — Indigo (primary, "Learn" mode, processing)
  primary: '#c0c1ff',
  'primary-container': '#8083ff',
  'on-primary': '#1000a9',
  'on-primary-container': '#0d0096',

  // Brand — Emerald (secondary, "Store" mode, encrypted/success)
  secondary: '#4edea3',
  'secondary-container': '#00a572',
  'on-secondary': '#003824',

  // Tertiary — Gold (premium tier, highlights)
  tertiary: '#ffb95f',
  'tertiary-container': '#ca8100',
  'on-tertiary': '#472a00',

  // Error — soft red, never alarming
  error: '#ffb4ab',
  'error-container': '#93000a',
  'on-error': '#690005',

  // Text
  'on-surface': '#dce1fb',
  'on-surface-variant': '#c7c4d7',
  'text-primary': '#F8FAFC',
  'text-muted': '#64748B',

  // Outlines
  outline: '#908fa0',
  'outline-variant': '#464554',
} as const;

export const fontFamily = {
  headline: ['Geist', 'sans-serif'],
  body: ['Inter', 'sans-serif'],
  mono: ['JetBrains Mono', 'monospace'],
};

/** 8px base scale. Numbers map to rem multiples of 0.25 (Tailwind default). */
export const spacing = {
  'nav-height': '72px',
  'nav-height-mobile': '64px',
  'page-margin-mobile': '1rem',
  'page-margin-desktop': '2rem',
  'card-gap': '1rem',
  'section-padding': '3rem',
} as const;

export const radii = {
  sm: '0.25rem',
  DEFAULT: '0.5rem',
  md: '0.75rem',
  lg: '1rem',
  xl: '1.5rem',
  full: '9999px',
} as const;

export const shadows = {
  // Subtle luminosity rather than heavy drop shadow
  card: '0 1px 2px 0 rgb(0 0 0 / 0.20)',
  'card-hover': '0 4px 12px 0 rgb(0 0 0 / 0.30)',
  modal: '0 20px 60px 0 rgb(0 0 0 / 0.50)',
  nav: '0 -4px 20px 0 rgb(0 0 0 / 0.30)',
  // Encryption gradient border (used on Card hover via outline-color)
  'encryption-glow': '0 0 20px 0 rgba(192, 193, 255, 0.20)',
} as const;

export const motion = {
  fast: '120ms',
  base: '200ms',
  slow: '300ms',
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/**
 * Aggregate token export consumed by the Tailwind preset.
 * Adding a new category: extend this object, then update `tailwind-preset.ts`.
 */
export const tokens = { colors, fontFamily, spacing, radii, shadows, motion } as const;

export type ColorToken = keyof typeof colors;
export type SpacingToken = keyof typeof spacing;
export type RadiusToken = keyof typeof radii;
