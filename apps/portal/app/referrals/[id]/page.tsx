import { getReferral } from '../../../lib/api';
import ReferralStatusBadge from '../../../components/ReferralStatusBadge';

interface Props {
  params: { id: string };
}

export const dynamic = 'force-dynamic';

const FIELD_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px 1fr',
  gap: '6px 16px',
  fontSize: '0.875rem',
  padding: '8px 0',
  borderBottom: '1px solid #f3f4f6',
  alignItems: 'start',
};

const LABEL_STYLE: React.CSSProperties = {
  color: '#6b7280',
  fontWeight: 600,
};

export default async function ReferralDetailPage({ params }: Props) {
  const referral = await getReferral(params.id);

  if (!referral) {
    return (
      <div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '16px' }}>
          Referral not found.
        </h1>
        <p style={{ color: '#6b7280' }}>
          No referral with ID <code>{params.id}</code> exists.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '720px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, fontFamily: 'monospace' }}>
          {referral.id}
        </h1>
        <ReferralStatusBadge status={referral.status} />
      </div>

      {/* Core details */}
      <section
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: '10px',
          padding: '20px 24px',
          marginBottom: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: '0.9rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af' }}>
          Referral Details
        </h2>

        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>From Org</span>
          <code style={{ fontSize: '0.85rem' }}>{referral.fromOrgId}</code>
        </div>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>To Org</span>
          <code style={{ fontSize: '0.85rem' }}>{referral.toOrgId}</code>
        </div>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Channel</span>
          <span style={{ textTransform: 'capitalize' }}>{referral.channel}</span>
        </div>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Data Type</span>
          <span>{referral.request.dataType}</span>
        </div>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Priority</span>
          <span style={{ textTransform: 'capitalize' }}>{referral.request.priority}</span>
        </div>
        {referral.request.notes && (
          <div style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Notes</span>
            <span>{referral.request.notes}</span>
          </div>
        )}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Created</span>
          <span>{new Date(referral.createdAt).toLocaleString()}</span>
        </div>
        <div style={{ ...FIELD_STYLE, borderBottom: 'none' }}>
          <span style={LABEL_STYLE}>Updated</span>
          <span>{new Date(referral.updatedAt).toLocaleString()}</span>
        </div>
      </section>

      {/* Patient */}
      <section
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: '10px',
          padding: '20px 24px',
          marginBottom: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: '0.9rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af' }}>
          Patient
        </h2>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Name</span>
          <span>{referral.patient.firstName} {referral.patient.lastName}</span>
        </div>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Date of Birth</span>
          <span>{referral.patient.dateOfBirth}</span>
        </div>
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>External ID</span>
          <code style={{ fontSize: '0.85rem' }}>{referral.patient.externalId}</code>
        </div>
        {referral.patient.centralId && (
          <div style={{ ...FIELD_STYLE, borderBottom: 'none' }}>
            <span style={LABEL_STYLE}>Central MPI ID</span>
            <code style={{ fontSize: '0.85rem' }}>{referral.patient.centralId}</code>
          </div>
        )}
      </section>

      {/* Status history */}
      <section
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: '10px',
          padding: '20px 24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}
      >
        <h2 style={{ margin: '0 0 20px', fontSize: '0.9rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af' }}>
          Status History
        </h2>

        {referral.statusHistory.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: '0.875rem', margin: 0 }}>No history yet.</p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0' }}>
            {referral.statusHistory.map((entry, idx) => (
              <li
                key={idx}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '12px 1fr',
                  gap: '0 16px',
                  position: 'relative',
                }}
              >
                {/* Timeline connector */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: '#2563eb',
                      marginTop: '4px',
                      flexShrink: 0,
                    }}
                  />
                  {idx < referral.statusHistory.length - 1 && (
                    <div style={{ width: '2px', flex: 1, background: '#e5e7eb', minHeight: '24px' }} />
                  )}
                </div>

                <div style={{ paddingBottom: '20px' }}>
                  <ReferralStatusBadge status={entry.status} />
                  <div style={{ color: '#9ca3af', fontSize: '0.78rem', marginTop: '4px' }}>
                    {new Date(entry.timestamp).toLocaleString()}
                  </div>
                  {entry.note && (
                    <div style={{ fontSize: '0.875rem', color: '#374151', marginTop: '4px' }}>
                      {entry.note}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
