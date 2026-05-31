'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Org } from '@ce2/types';
import { listOrgs, createReferral } from '../../../lib/api';
import ReferralForm from '../../../components/ReferralForm';
import type { CreateReferralInput, OrgChannel } from '@ce2/types';

export default function NewReferralPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listOrgs().then((data) => {
      setOrgs(data);
      setLoading(false);
    });
  }, []);

  async function handleSubmit(data: CreateReferralInput & { channel: OrgChannel }) {
    await createReferral(data);
    router.push('/referrals');
  }

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '24px' }}>
        New Referral
      </h1>

      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading organizations…</p>
      ) : (
        <ReferralForm orgs={orgs} onSubmit={handleSubmit} />
      )}
    </div>
  );
}
