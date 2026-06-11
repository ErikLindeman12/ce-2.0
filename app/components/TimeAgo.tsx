'use client';

import { useEffect, useState } from 'react';

function formatAgo(isoString: string): string {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function TimeAgo({ iso }: { iso: string }) {
  const [label, setLabel] = useState(() => formatAgo(iso));

  useEffect(() => {
    const interval = setInterval(() => setLabel(formatAgo(iso)), 10_000);
    return () => clearInterval(interval);
  }, [iso]);

  return <span title={new Date(iso).toLocaleString()}>{label}</span>;
}
