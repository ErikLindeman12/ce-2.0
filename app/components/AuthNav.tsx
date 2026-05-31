'use client';

export function AuthNav({ email }: { email: string | null }) {
  if (!email) {
    return (
      <a
        href="/auth/login"
        style={{
          color: '#93c5fd',
          fontSize: '0.85rem',
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        Sign in
      </a>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ fontSize: '0.82rem', color: '#cbd5e1' }}>{email}</span>
      <form action="/auth/signout" method="POST">
        <button
          type="submit"
          style={{
            background: 'transparent',
            border: '1px solid #93c5fd',
            color: '#93c5fd',
            padding: '4px 12px',
            borderRadius: 4,
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
