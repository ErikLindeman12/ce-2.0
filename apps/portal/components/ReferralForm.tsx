'use client';

import { useState } from 'react';
import type { Org, CreateReferralInput, OrgChannel } from '@ce2/types';
import OrgSelector from './OrgSelector';

interface Props {
  orgs: Org[];
  onSubmit: (data: CreateReferralInput & { channel: OrgChannel }) => Promise<void>;
}

interface FormState {
  fromOrgId: string;
  toOrgId: string;
  channel: OrgChannel;
  patientFirstName: string;
  patientLastName: string;
  patientDateOfBirth: string;
  patientExternalId: string;
  dataType: string;
  priority: 'routine' | 'urgent' | 'stat';
  notes: string;
}

const INITIAL_STATE: FormState = {
  fromOrgId: '',
  toOrgId: '',
  channel: 'cloud',
  patientFirstName: '',
  patientLastName: '',
  patientDateOfBirth: '',
  patientExternalId: '',
  dataType: '',
  priority: 'routine',
  notes: '',
};

const FIELD_STYLE: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.875rem',
  color: '#111827',
  width: '100%',
  boxSizing: 'border-box',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '0.875rem',
  fontWeight: 600,
  color: '#374151',
};

export default function ReferralForm({ orgs, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload: CreateReferralInput & { channel: OrgChannel } = {
        fromOrgId: form.fromOrgId,
        toOrgId: form.toOrgId,
        channel: form.channel,
        patient: {
          externalId: form.patientExternalId,
          firstName: form.patientFirstName,
          lastName: form.patientLastName,
          dateOfBirth: form.patientDateOfBirth,
        },
        request: {
          dataType: form.dataType,
          priority: form.priority,
          notes: form.notes || undefined,
        },
      };
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}
    >
      {/* Organizations */}
      <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}>
        <legend style={{ fontWeight: 700, padding: '0 6px', color: '#111827' }}>
          Organizations
        </legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <OrgSelector
            orgs={orgs}
            value={form.fromOrgId}
            onChange={(id) => set('fromOrgId', id)}
            label="From Organization"
          />
          <OrgSelector
            orgs={orgs}
            value={form.toOrgId}
            onChange={(id) => set('toOrgId', id)}
            label="To Organization"
          />
          <label style={LABEL_STYLE}>
            Channel
            <select
              value={form.channel}
              onChange={(e) => set('channel', e.target.value as OrgChannel)}
              style={FIELD_STYLE}
            >
              <option value="cloud">Cloud</option>
              <option value="fax">Fax</option>
              <option value="direct">Direct</option>
              <option value="portal">Portal</option>
            </select>
          </label>
        </div>
      </fieldset>

      {/* Patient */}
      <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}>
        <legend style={{ fontWeight: 700, padding: '0 6px', color: '#111827' }}>
          Patient
        </legend>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <label style={LABEL_STYLE}>
            First Name
            <input
              type="text"
              required
              value={form.patientFirstName}
              onChange={(e) => set('patientFirstName', e.target.value)}
              style={FIELD_STYLE}
            />
          </label>
          <label style={LABEL_STYLE}>
            Last Name
            <input
              type="text"
              required
              value={form.patientLastName}
              onChange={(e) => set('patientLastName', e.target.value)}
              style={FIELD_STYLE}
            />
          </label>
          <label style={LABEL_STYLE}>
            Date of Birth
            <input
              type="date"
              required
              value={form.patientDateOfBirth}
              onChange={(e) => set('patientDateOfBirth', e.target.value)}
              style={FIELD_STYLE}
            />
          </label>
          <label style={LABEL_STYLE}>
            External Patient ID
            <input
              type="text"
              required
              value={form.patientExternalId}
              onChange={(e) => set('patientExternalId', e.target.value)}
              placeholder="e.g. E123456"
              style={FIELD_STYLE}
            />
          </label>
        </div>
      </fieldset>

      {/* Request */}
      <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}>
        <legend style={{ fontWeight: 700, padding: '0 6px', color: '#111827' }}>
          Request
        </legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label style={LABEL_STYLE}>
            Data Type
            <input
              type="text"
              required
              value={form.dataType}
              onChange={(e) => set('dataType', e.target.value)}
              placeholder="e.g. labs, consult, imaging"
              style={FIELD_STYLE}
            />
          </label>
          <label style={LABEL_STYLE}>
            Priority
            <select
              value={form.priority}
              onChange={(e) =>
                set('priority', e.target.value as 'routine' | 'urgent' | 'stat')
              }
              style={FIELD_STYLE}
            >
              <option value="routine">Routine</option>
              <option value="urgent">Urgent</option>
              <option value="stat">Stat</option>
            </select>
          </label>
          <label style={LABEL_STYLE}>
            Notes (optional)
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              style={{ ...FIELD_STYLE, resize: 'vertical' }}
            />
          </label>
        </div>
      </fieldset>

      {error && (
        <p style={{ color: '#b91c1c', fontSize: '0.875rem', margin: 0 }}>{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        style={{
          padding: '10px 20px',
          background: loading ? '#9ca3af' : '#2563eb',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          fontSize: '0.9rem',
          fontWeight: 600,
          cursor: loading ? 'not-allowed' : 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        {loading ? 'Submitting…' : 'Submit Referral'}
      </button>
    </form>
  );
}
