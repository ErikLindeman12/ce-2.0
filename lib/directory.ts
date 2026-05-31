import { searchOrgs } from './organizations';
import { searchProviders } from './providers';
import type { DirectorySearchResult } from './types';

export async function searchDirectory(query: string): Promise<DirectorySearchResult> {
  const [organizations, providers] = await Promise.all([
    searchOrgs(query),
    searchProviders({ query }),
  ]);

  return { organizations, providers };
}
