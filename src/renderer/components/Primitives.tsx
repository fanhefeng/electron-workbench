import type {
  ButtonHTMLAttributes,
  ComponentPropsWithRef,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from 'react';
import { LoaderCircle } from 'lucide-react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'normal' | 'small' | 'icon';
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
};
export function Button({
  variant = 'secondary',
  size = 'normal',
  loading = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`ui-button ${className}`}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle size={14} className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonProps & { label: string; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  );
}
export function TextInput({ className = '', ...props }: ComponentPropsWithRef<'input'>) {
  return <input className={`ui-input ${className}`} {...props} />;
}
export function Select<T extends string>({
  options,
  onValueChange,
  className = '',
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> & {
  value: T;
  options: readonly { value: T; label: string }[];
  onValueChange: (value: T) => void;
}) {
  return (
    <select
      className={`ui-select ${className}`}
      onChange={(event) => onValueChange(event.target.value as T)}
      {...props}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
export function Toggle({
  id,
  checked,
  onChange,
  label,
  disabled,
  describedBy,
}: {
  id?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      className="ui-switch"
      id={id}
      type="checkbox"
      role="switch"
      aria-label={label}
      aria-describedby={describedBy}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
export function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <label htmlFor={id}>{label}</label>
        {description && <p id={`${id}-hint`}>{description}</p>}
      </div>
      {children}
    </div>
  );
}
