import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';

/** 右侧抽屉：新建/编辑条目、笔记等 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="关闭" />
      <div
        className="relative h-full bg-bg-panel border-l border-line flex flex-col shadow-2xl"
        style={{ width: Math.min(width, window.innerWidth) }}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-line shrink-0">
          <div className="text-sm font-medium">{title}</div>
          <button className="btn btn-ghost px-1.5" onClick={onClose}>
            <Icon name="X" size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex p-0.5 rounded-md bg-bg-elev border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 rounded text-xs transition-colors ${
            value === o.value ? 'bg-accent text-white' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="text-center py-10 text-fg-dim text-sm">
      <div>{text}</div>
      {hint && <div className="text-xs mt-1 text-fg-dim/70">{hint}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="sec-title">
        {title}
        {count !== undefined && <span className="ml-1.5 text-fg-dim/70">{count}</span>}
      </div>
      {action}
    </div>
  );
}
