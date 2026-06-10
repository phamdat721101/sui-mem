/**
 * Tailwind preset auto-derived from `tokens.ts`.
 *
 * Usage in a Tailwind config:
 *   import preset from '@fhe-ai-context/ui/tailwind-preset';
 *   export default { presets: [preset], content: [...] };
 */

import { colors, fontFamily, spacing, radii, shadows } from './tokens';

const preset = {
  darkMode: 'class' as const,
  theme: {
    extend: {
      colors,
      fontFamily,
      spacing,
      borderRadius: radii,
      boxShadow: shadows,
    },
  },
};

export default preset;
