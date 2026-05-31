'use client';

import type { Org } from '@ce2/types';

interface Props {
  orgs: Org[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}

export default function OrgSelector({ orgs, value, onChange, label }: Props) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '8px 10px',
          border: '1px solid #d1d5db',
          borderRadius: '6px',
          fontSize: '0.875rem',
          background: '#fff',
          color: '#111827',
          cursor: 'pointer',
        }}
      >
        <option value="">— Select organization —</option>
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name} ({org.tenantSlug})
          </option>
        ))}
      </select>
    </label>
  );
}
