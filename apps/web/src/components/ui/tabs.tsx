import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex flex-wrap gap-1 rounded-md border border-border bg-accent p-1',
        className,
      )}
    >
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            'rounded px-3 py-1 text-sm transition-colors',
            value === it.value ? 'bg-card shadow font-medium' : 'text-muted hover:text-fg',
          )}
        >
          {it.label}
          {it.count !== undefined ? (
            <span className="ml-1 text-xs text-muted">({it.count})</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
