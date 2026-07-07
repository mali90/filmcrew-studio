// First-run gate: when setup is incomplete the whole app routes to /setup (route takeover, never
// a modal). Re-checks after the wizard writes .env.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function useSetupGate() {
  const q = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus, staleTime: 5_000 });
  return {
    loading: q.isLoading,
    complete: q.data?.complete ?? false,
    status: q.data,
    refresh: q.refetch,
  };
}
