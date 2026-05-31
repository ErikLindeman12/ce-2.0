import { searchOrgs } from './organizations';
import { searchProviders } from './providers';
import type { DirectoryFilters, DirectorySearchResult } from './types';

export async function searchDirectory(filters: DirectoryFilters = {}): Promise<DirectorySearchResult> {
  const [organizations, providers] = await Promise.all([
    searchOrgs(filters),
    searchProviders(filters),
  ]);

  return { organizations, providers };
}
