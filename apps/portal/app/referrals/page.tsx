import Link from 'next/link';
import { listReferrals, listOrgs } from '../../lib/api';
import ReferralList from '../../components/ReferralList';

export const dynamic = 'force-dynamic';

export default async function ReferralsPage() {
  const [referrals, _orgs] = await Promise.all([listReferrals(), listOrgs()]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800 }}>Referrals</h1>
        <Link
          href="/referrals/new"
          style={{
            padding: '9px 18px',
            background: '#2563eb',
            color: '#fff',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.875rem',
          }}
        >
          + New Referral
        </Link>
      </div>

      <ReferralList referrals={referrals} />
    </div>
  );
}
