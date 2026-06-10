/**
 * @fhe-ai-context/ui — design system v1.
 *
 * Public surface:
 *   - Tokens (single source of truth)
 *   - Tailwind preset (consume tokens in any consumer's Tailwind config)
 *   - Primitives (12) and Molecules (8)
 *   - cn() utility
 *
 * Storybook + Lighthouse CI land in T13 alongside the screens that consume them.
 */

export * from './tokens';
export { default as tailwindPreset } from './tailwind-preset';
export * from './primitives';
export * from './molecules';
export * from './utils';
