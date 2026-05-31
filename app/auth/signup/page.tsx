'use client';

import { useState } from 'react';
import { createAuthClientBrowser } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createAuthClientBrowser();
    const { error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <div style={{ maxWidth: 400, margin: '60px auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 4 }}>Create account</h1>
      <p style={{ color: '#6b7280', marginTop: 0, marginBottom: 24, fontSize: '0.9rem' }}>
        Sign up to access the CE 2.0 portal.
      </p>

      <form onSubmit={handleSignup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{
              display: 'block',
              width: '100%',
              padding: '10px 12px',
              marginTop: 4,
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.95rem',
            }}
          />
        </label>

        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            style={{
              display: 'block',
              width: '100%',
              padding: '10px 12px',
              marginTop: 4,
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: '0.95rem',
            }}
          />
        </label>

        {error && (
          <p style={{ color: '#dc2626', fontSize: '0.85rem', margin: 0 }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '10px 0',
            background: loading ? '#93c5fd' : '#1e3a5f',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: '0.95rem',
            fontWeight: 600,
            cursor: loading ? 'default' : 'pointer',
            marginTop: 4,
          }}
        >
          {loading ? 'Creating account…' : 'Sign up'}
        </button>
      </form>

      <p style={{ marginTop: 20, fontSize: '0.85rem', color: '#6b7280', textAlign: 'center' }}>
        Already have an account?{' '}
        <a href="/auth/login" style={{ color: '#1e3a5f', fontWeight: 600, textDecoration: 'none' }}>
          Sign in
        </a>
      </p>
    </div>
  );
}
