import type { ReactNode } from 'react';

export function Loading({ label = '读取赛场数据…' }: { label?: string }) {
  return <div className="state-view" role="status"><span className="loader" /><p>{label}</p></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="state-view error-state" role="alert"><span className="state-code">ERROR</span><p>{message}</p>{onRetry && <button className="btn ghost small" onClick={onRetry}>重新加载</button>}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="state-view"><span className="state-code">EMPTY</span><p>{title}</p>{children && <div className="state-action">{children}</div>}</div>;
}

export function PageHead({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow || 'SERPENT / ARENA'}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</div>;
}
