import Link from 'next/link';

const CARD_STYLE: React.CSSProperties = {
  display: 'block',
  padding: '24px 28px',
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: '10px',
  textDecoration: 'none',
  color: '#111827',
  boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
  transition: 'box-shadow 0.15s',
};

const SERVICE_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '10px 0',
  borderBottom: '1px solid #f3f4f6',
  fontSize: '0.875rem',
};

export default function HomePage() {
  return (
    <div>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 6px' }}>
        CE 2.0 — Care Everywhere
      </h1>
      <p style={{ color: '#6b7280', marginTop: 0, marginBottom: '36px', fontSize: '1rem' }}>
        Cloud-native cross-org interoperability platform
      </p>

      {/* Quick-nav cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '48px' }}>
        <Link href="/referrals" style={CARD_STYLE}>
          <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>📋</div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>View Referrals</div>
          <div style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: '4px' }}>
            Browse and track all cross-org referrals
          </div>
        </Link>

        <Link href="/referrals/new" style={CARD_STYLE}>
          <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>➕</div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>New Referral</div>
          <div style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: '4px' }}>
            Submit a new referral to another organization
          </div>
        </Link>
      </div>

      {/* Service status */}
      <section>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#374151', marginBottom: '12px' }}>
          Backend Services
        </h2>
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            padding: '4px 20px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}
        >
          {[
            { name: 'Directory', url: 'http://localhost:3001/health' },
            { name: 'Broker', url: 'http://localhost:3002/health' },
            { name: 'Referral Intake', url: 'http://localhost:3003/health' },
          ].map((svc) => (
            <div key={svc.name} style={SERVICE_ROW_STYLE}>
              <span
                style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: '#d1d5db',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 600, minWidth: '140px' }}>{svc.name}</span>
              <code style={{ color: '#6b7280', fontSize: '0.8rem' }}>{svc.url}</code>
            </div>
          ))}
        </div>
        <p style={{ fontSize: '0.78rem', color: '#9ca3af', marginTop: '8px' }}>
          Health endpoint URLs shown for reference — status not polled in this view.
        </p>
      </section>
    </div>
  );
}
