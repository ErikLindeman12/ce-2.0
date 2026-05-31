'use client';

import Link from 'next/link';
import type { Referral } from '@ce2/types';
import ReferralStatusBadge from './ReferralStatusBadge';

interface Props {
  referrals: Referral[];
}

const TH_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: '0.75rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#6b7280',
  borderBottom: '2px solid #e5e7eb',
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: '0.875rem',
  color: '#374151',
  borderBottom: '1px solid #f3f4f6',
  verticalAlign: 'middle',
};

export default function ReferralList({ referrals }: Props) {
  if (referrals.length === 0) {
    return (
      <p style={{ color: '#6b7280', fontSize: '0.9rem', marginTop: '24px' }}>
        No referrals found.
      </p>
    );
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: '16px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>ID</th>
            <th style={TH_STYLE}>From Org</th>
            <th style={TH_STYLE}>To Org</th>
            <th style={TH_STYLE}>Patient</th>
            <th style={TH_STYLE}>Type</th>
            <th style={TH_STYLE}>Priority</th>
            <th style={TH_STYLE}>Status</th>
            <th style={TH_STYLE}>Created</th>
          </tr>
        </thead>
        <tbody>
          {referrals.map((r) => (
            <tr
              key={r.id}
              style={{ transition: 'background 0.1s' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLTableRowElement).style.background = '#f9fafb')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLTableRowElement).style.background = '')
              }
            >
              <td style={TD_STYLE}>
                <Link
                  href={`/referrals/${r.id}`}
                  style={{ color: '#2563eb', textDecoration: 'none', fontFamily: 'monospace', fontWeight: 600 }}
                >
                  {r.id.slice(0, 8)}
                </Link>
              </td>
              <td style={{ ...TD_STYLE, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {r.fromOrgId.slice(0, 10)}…
              </td>
              <td style={{ ...TD_STYLE, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {r.toOrgId.slice(0, 10)}…
              </td>
              <td style={TD_STYLE}>
                {r.patient.firstName} {r.patient.lastName}
              </td>
              <td style={TD_STYLE}>{r.request.dataType}</td>
              <td style={{ ...TD_STYLE, textTransform: 'capitalize' }}>{r.request.priority}</td>
              <td style={TD_STYLE}>
                <ReferralStatusBadge status={r.status} />
              </td>
              <td style={{ ...TD_STYLE, whiteSpace: 'nowrap', color: '#9ca3af' }}>
                {new Date(r.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
