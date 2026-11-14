import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Props = {
  title: string;
  description?: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
};

export default function LocationDialog({ title, description, onClose, busy = false, children, footer }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy; }, [onClose, busy]);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
      )).filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      const outside = !dialog.current.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === dialog.current)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="location-ui loc-overlay" onClick={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="loc-dialog">
      <header className="loc-dialog-header">
        <div className="min-w-0"><h2>{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" className="loc-icon-button" aria-label={title === '地图选择签到位置' ? '关闭地图' : title === '选择签到位置' ? '关闭地点列表' : '关闭'} disabled={busy} onClick={onClose}><X size={20} /></button>
      </header>
      <div className="loc-dialog-body">{children}</div>
      {footer && <footer className="loc-dialog-footer">{footer}</footer>}
    </div>
  </div>, document.body);
}
