import React, { type ReactNode } from 'react';

export type ShowcaseMode = 'CSR' | 'SSR' | 'Streaming SSR' | 'SSG' | 'ISR' | 'Runtime';

export function ModeBadge({ mode }: { mode: ShowcaseMode }): React.ReactElement {
  const slug = mode.toLowerCase().replace(/\s+/g, '-');
  return <span className={`mode-badge mode-badge--${slug}`}>{mode}</span>;
}

export interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: ReactNode;
  mode?: ShowcaseMode;
  actions?: ReactNode;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  mode,
  actions,
}: PageHeaderProps): React.ReactElement {
  return (
    <header className="page-header">
      <div className="page-header__eyebrow">
        {mode ? <ModeBadge mode={mode} /> : null}
        <span>{eyebrow}</span>
      </div>
      <h1>{title}</h1>
      <div className="page-header__description">{description}</div>
      {actions ? <div className="button-row">{actions}</div> : null}
    </header>
  );
}

export function FeatureGrid({ children }: { children: ReactNode }): React.ReactElement {
  return <section className="feature-grid">{children}</section>;
}

export interface FeatureCardProps {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  accent?: 'blue' | 'violet' | 'green' | 'amber' | 'red';
}

export function FeatureCard({
  title,
  eyebrow,
  children,
  accent = 'blue',
}: FeatureCardProps): React.ReactElement {
  return (
    <article className={`feature-card feature-card--${accent}`}>
      {eyebrow ? <span className="feature-card__eyebrow">{eyebrow}</span> : null}
      <h2>{title}</h2>
      <div className="feature-card__body">{children}</div>
    </article>
  );
}

export function DataGrid({
  entries,
}: {
  entries: Array<{ label: string; value: ReactNode; code?: boolean }>;
}): React.ReactElement {
  return (
    <dl className="data-grid">
      {entries.map((entry) => (
        <div key={entry.label}>
          <dt>{entry.label}</dt>
          <dd>{entry.code ? <code>{entry.value}</code> : entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CodeBlock({ children }: { children: string }): React.ReactElement {
  return (
    <pre className="code-block">
      <code>{children}</code>
    </pre>
  );
}

export function Callout({
  title,
  children,
  tone = 'info',
}: {
  title: string;
  children: ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}): React.ReactElement {
  return (
    <aside className={`callout callout--${tone}`}>
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}

export function EmptyState({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="empty-state">{children}</div>;
}
