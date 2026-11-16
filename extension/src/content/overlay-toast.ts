import { ICONS, escapeHtml } from './icons';

export interface ToastOptions {
  kind?: 'info' | 'ok' | 'error';
  /** Optional action button, e.g. Undo. */
  action?: { label: string; icon: string; run: () => void };
  durationMs?: number;
}

/**
 * One non-blocking message at the top of the player, replacing alert().
 * A new message replaces the previous one.
 */
export function showOverlayToast(parent: HTMLElement, message: string, options: ToastOptions = {}): void {
  parent.querySelector('.vdt-toast')?.remove();
  const { kind = 'info', action, durationMs = action ? 6000 : kind === 'error' ? 5000 : 2500 } = options;

  const toast = document.createElement('div');
  toast.className = `vdt-toast vdt-toast-${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = kind === 'error' ? ICONS.alert : kind === 'ok' ? ICONS.check : ICONS.saved;
  toast.innerHTML = `
    <span class="vdt-toast-icon">${icon}</span>
    <span class="vdt-toast-text">${escapeHtml(message)}</span>
    ${action ? `<button class="vdt-btn vdt-toast-action" title="${escapeHtml(action.label)}" aria-label="${escapeHtml(action.label)}">${action.icon}<span>${escapeHtml(action.label)}</span></button>` : ''}
  `;
  for (const type of ['click', 'mousedown', 'pointerdown', 'dblclick']) {
    toast.addEventListener(type, (e) => e.stopPropagation());
  }

  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    toast.classList.add('vdt-toast-out');
    window.setTimeout(() => toast.remove(), 200);
  };
  toast.querySelector('.vdt-toast-action')?.addEventListener('click', () => {
    action?.run();
    dismiss();
  });

  parent.appendChild(toast);
  timer = window.setTimeout(dismiss, durationMs);
}
