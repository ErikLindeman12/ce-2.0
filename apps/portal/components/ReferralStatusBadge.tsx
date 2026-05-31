import type { ReferralStatus } from '@ce2/types';

interface Props {
  status: ReferralStatus;
}

const STATUS_STYLES: Record<ReferralStatus, React.CSSProperties> = {
  received:  { background: '#e5e7eb', color: '#374151' },
  triaged:   { background: '#dbeafe', color: '#1d4ed8' },
  accepted:  { background: '#dcfce7', color: '#15803d' },
  declined:  { background: '#fee2e2', color: '#b91c1c' },
  scheduled: { background: '#ede9fe', color: '#6d28d9' },
  completed: { background: '#ccfbf1', color: '#0f766e' },
  cancelled: { background: '#e5e7eb', color: '#6b7280' },
};

const BASE_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 10px',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'capitalize',
  letterSpacing: '0.02em',
};

export default function ReferralStatusBadge({ status }: Props) {
  return (
    <span style={{ ...BASE_STYLE, ...STATUS_STYLES[status] }}>
      {status}
    </span>
  );
}
