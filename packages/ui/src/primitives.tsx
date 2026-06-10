/**
 * Primitive UI components for FHE Second Brain v1.0.
 *
 * SOLID:
 * - Each component has its own typed props interface (single responsibility).
 * - Variant logic is data-driven (lookup tables) — Open/Closed: add variants without rewriting render.
 * - No business logic — purely presentational. Composes into molecules.
 *
 * Conventions:
 * - All components accept `className` for caller-side overrides.
 * - All interactive components forward refs and accept native HTML attributes via spread.
 * - Mode coloring (Learn=indigo / Store=emerald) is enforced where relevant — see `Button` `tone`.
 */
import * as React from 'react';
import { cn } from './utils';

// ---------- Button ----------------------------------------------------------

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_TONE: Record<ButtonTone, string> = {
  primary: 'bg-primary-container text-on-primary-container hover:opacity-90',
  secondary: 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest',
  ghost: 'bg-transparent text-on-surface-variant hover:text-on-surface',
  danger: 'bg-error-container text-on-error hover:opacity-90',
  success: 'bg-secondary-container text-on-secondary hover:opacity-90',
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-base',
  lg: 'h-12 px-6 text-base',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ tone = 'primary', size = 'md', className, ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'disabled:opacity-50 disabled:pointer-events-none',
        BUTTON_TONE[tone],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = 'Button';

// ---------- Input -----------------------------------------------------------

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, id, className, ...rest }, ref) => {
    const inputId = id ?? React.useId();
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm text-on-surface-variant">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error)}
          className={cn(
            'h-10 rounded bg-surface-container border border-border px-3 text-on-surface',
            'placeholder:text-text-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            error && 'border-error',
            className,
          )}
          {...rest}
        />
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    );
  },
);
Input.displayName = 'Input';

// ---------- Textarea --------------------------------------------------------

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, id, className, ...rest }, ref) => {
    const taId = id ?? React.useId();
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={taId} className="text-sm text-on-surface-variant">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={taId}
          aria-invalid={Boolean(error)}
          className={cn(
            'min-h-[6rem] rounded bg-surface-container border border-border p-3 text-on-surface',
            'placeholder:text-text-muted resize-y',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            error && 'border-error',
            className,
          )}
          {...rest}
        />
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    );
  },
);
Textarea.displayName = 'Textarea';

// ---------- Select ----------------------------------------------------------

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, id, className, children, ...rest }, ref) => {
    const sId = id ?? React.useId();
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={sId} className="text-sm text-on-surface-variant">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={sId}
          className={cn(
            'h-10 rounded bg-surface-container border border-border px-3 text-on-surface',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
      </div>
    );
  },
);
Select.displayName = 'Select';

// ---------- Card ------------------------------------------------------------

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** When true, hover glows with the brand "encryption" border. */
  interactive?: boolean;
}

export const Card: React.FC<CardProps> = ({ interactive, className, ...rest }) => (
  <div
    className={cn(
      'rounded-lg border border-border bg-card p-4 shadow-card transition-shadow',
      interactive && 'cursor-pointer hover:shadow-encryption-glow hover:border-primary-container',
      className,
    )}
    {...rest}
  />
);

// ---------- Badge -----------------------------------------------------------

type BadgeTone = 'default' | 'encrypted' | 'private' | 'warning' | 'danger' | 'success';

const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'bg-surface-container-high text-on-surface-variant',
  encrypted: 'bg-secondary-container/20 text-secondary',
  private: 'bg-surface-container-high text-text-muted',
  warning: 'bg-tertiary-container/20 text-tertiary',
  danger: 'bg-error-container/20 text-error',
  success: 'bg-secondary-container/20 text-secondary',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({ tone = 'default', icon, className, children, ...rest }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
      BADGE_TONE[tone],
      className,
    )}
    {...rest}
  >
    {icon}
    {children}
  </span>
);

// ---------- Tooltip ---------------------------------------------------------

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
}

/**
 * Minimal CSS-only tooltip on hover/focus. For complex positioning use a
 * floating-ui-based tooltip later; this covers the design system needs today.
 */
export const Tooltip: React.FC<TooltipProps> = ({ content, children }) => (
  <span className="group relative inline-flex">
    {children}
    <span
      role="tooltip"
      className={cn(
        'pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap',
        'rounded bg-surface-container-highest px-2 py-1 text-xs text-on-surface',
        'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
      )}
    >
      {content}
    </span>
  </span>
);

// ---------- Modal -----------------------------------------------------------

export interface ModalProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, className, children, ...rest }) => {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur"
      onClick={onClose}
    >
      <div
        className={cn(
          'mx-4 w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-modal',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        {...rest}
      >
        {title && <h2 className="mb-4 text-lg font-semibold text-on-surface">{title}</h2>}
        {children}
      </div>
    </div>
  );
};

// ---------- Stepper ---------------------------------------------------------

export interface StepperProps {
  steps: ReadonlyArray<{ label: string; description?: string }>;
  /** Zero-based current step index. */
  current: number;
  /** Optional zero-based set of failed indexes. */
  failed?: ReadonlyArray<number>;
}

export const Stepper: React.FC<StepperProps> = ({ steps, current, failed = [] }) => (
  <ol className="flex flex-col gap-3" aria-label="Progress">
    {steps.map((step, i) => {
      const isDone = i < current;
      const isCurrent = i === current;
      const isFailed = failed.includes(i);
      return (
        <li key={step.label} className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
              isFailed
                ? 'bg-error-container text-on-error'
                : isDone
                  ? 'bg-secondary-container text-on-secondary'
                  : isCurrent
                    ? 'bg-primary-container text-on-primary-container animate-pulse'
                    : 'bg-surface-container-high text-text-muted',
            )}
          >
            {isFailed ? '!' : isDone ? '✓' : i + 1}
          </span>
          <div className="flex flex-col">
            <span className={cn('text-sm', isCurrent ? 'text-on-surface' : 'text-on-surface-variant')}>
              {step.label}
            </span>
            {step.description && <span className="text-xs text-text-muted">{step.description}</span>}
          </div>
        </li>
      );
    })}
  </ol>
);

// ---------- Skeleton --------------------------------------------------------

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Skeleton: React.FC<SkeletonProps> = ({ className, ...rest }) => (
  <div
    aria-hidden
    className={cn('animate-pulse rounded bg-surface-container-high', className)}
    {...rest}
  />
);

// ---------- Spinner ---------------------------------------------------------

export interface SpinnerProps {
  size?: number;
  label?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 16, label = 'Loading' }) => (
  <span
    role="status"
    aria-label={label}
    style={{ width: size, height: size }}
    className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-primary"
  />
);

// ---------- Toast -----------------------------------------------------------

type ToastTone = 'info' | 'success' | 'warning' | 'danger';

const TOAST_TONE: Record<ToastTone, string> = {
  info: 'bg-surface-container-high text-on-surface',
  success: 'bg-secondary-container text-on-secondary',
  warning: 'bg-tertiary-container text-on-tertiary',
  danger: 'bg-error-container text-on-error',
};

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: ToastTone;
  onAction?: () => void;
  actionLabel?: string;
}

export const Toast: React.FC<ToastProps> = ({
  tone = 'info',
  onAction,
  actionLabel,
  className,
  children,
  ...rest
}) => (
  <div
    role="status"
    aria-live="polite"
    className={cn(
      'flex items-center gap-3 rounded-lg px-4 py-3 shadow-card',
      TOAST_TONE[tone],
      className,
    )}
    {...rest}
  >
    <span className="text-sm">{children}</span>
    {onAction && actionLabel && (
      <button
        type="button"
        onClick={onAction}
        className="ml-auto rounded px-2 py-1 text-xs font-medium underline-offset-2 hover:underline"
      >
        {actionLabel}
      </button>
    )}
  </div>
);
