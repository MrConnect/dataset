import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, type LucideIcon } from 'lucide-react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Shown as the tooltip and announced to screen readers. */
  label: string;
  variant?: Variant;
  spinning?: boolean;
  badge?: React.ReactNode;
}

/** Icon-only button. The label is never optional: it is the tooltip. */
export const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
  label,
  variant = 'default',
  spinning = false,
  badge,
  className = '',
  type = 'button',
  ...rest
}) => (
  <button type={type} className={`icon-btn ${variant} ${className}`} title={label} aria-label={label} {...rest}>
    <Icon size={15} className={spinning ? 'spin' : undefined} aria-hidden />
    {badge !== undefined && <span className="icon-btn-badge">{badge}</span>}
  </button>
);

/** Icon-styled file picker (a label wrapping a hidden input). */
export const IconFileButton: React.FC<{
  icon: LucideIcon;
  label: string;
  accept: string;
  variant?: Variant;
  disabled?: boolean;
  onFile: (file: File) => void;
}> = ({ icon: Icon, label, accept, variant = 'default', disabled, onFile }) => (
  <label className={`icon-btn ${variant} ${disabled ? 'disabled' : ''}`} title={label} aria-label={label}>
    <Icon size={15} aria-hidden />
    <input
      type="file"
      accept={accept}
      disabled={disabled}
      style={{ display: 'none' }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) onFile(file);
      }}
    />
  </label>
);

/**
 * Destructive action without a blocking dialog: the first click arms the
 * button (it turns red and shows a check), the second click within three
 * seconds runs the action.
 */
export const ConfirmButton: React.FC<{
  icon: LucideIcon;
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}> = ({ icon, label, confirmLabel, disabled, onConfirm }) => {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const handleClick = () => {
    if (armed) {
      clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 3000);
  };

  return (
    <IconButton
      icon={armed ? Check : icon}
      label={armed ? confirmLabel : label}
      variant="danger"
      className={armed ? 'armed' : ''}
      disabled={disabled}
      onClick={handleClick}
    />
  );
};

// --- toasts -----------------------------------------------------------------

type ToastKind = 'ok' | 'error';
type Notify = (message: string, kind?: ToastKind) => void;

const NotifyContext = createContext<Notify>(() => {});

export const useNotify = (): Notify => useContext(NotifyContext);

export const NotifyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  const nextId = useRef(1);

  const notify = useCallback<Notify>((message, kind = 'ok') => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.kind === 'error' ? <AlertTriangle size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
};
