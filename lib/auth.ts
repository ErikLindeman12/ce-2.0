import { redirect } from 'next/navigation';
import { createAuthClient } from '@/lib/supabase/server';
import { getSupabase } from '@/lib/supabase';
import type { OrgUser } from '@/lib/types';

interface SessionUser {
  id: string;
  email: string;
  orgUsers: OrgUser[];
}

/**
 * Get the authenticated user from the current request cookies.
 * Returns null if not authenticated.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = createAuthClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const admin = getSupabase();
  const { data: rows } = await admin
    .from('org_users')
    .select('id,user_id,org_id,role,created_at')
    .eq('user_id', user.id);

  const orgUsers: OrgUser[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    orgId: r.org_id as string,
    role: r.role as OrgUser['role'],
    createdAt: r.created_at as string,
  }));

  return {
    id: user.id,
    email: user.email ?? '',
    orgUsers,
  };
}

/**
 * Require authentication. Redirects to /auth/login if the user is not
 * signed in. Call this at the top of protected page server components.
 */
export async function requireAuth(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/auth/login');
  return user;
}
