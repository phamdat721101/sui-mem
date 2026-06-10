/** Conditionally join class names. Falsy values are filtered out. */
export function cn(...args: Array<string | false | null | undefined>): string {
  return args.filter(Boolean).join(' ');
}
