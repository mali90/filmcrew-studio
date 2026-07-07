import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { Shell } from './components/shell/Shell';
import { useSetupGate } from './hooks/useSetupGate';
import HomePage from './pages/Home';
import RunPage from './pages/Run';
import LibraryPage from './pages/Library';
import CastPage from './pages/Cast';
import CharacterPage from './pages/Character';
import SettingsPage from './pages/Settings';
import SetupPage from './pages/Setup';
import { ToastProvider } from './components/ui/Toast';
import { useNotifications } from './hooks/useNotifications';

export default function App() {
  const gate = useSetupGate();
  useNotifications();

  if (gate.loading) return null; // sub-400ms: no loading state, no flash
  if (!gate.complete) {
    return (
      <ToastProvider>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/cast" element={<CastPage />} />
          <Route path="/cast/new" element={<CharacterPage />} />
          <Route path="/cast/:slug" element={<CharacterPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/setup" element={<SetupWhenComplete />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}

// Once setup is complete, finishing the wizard flips the gate and this route swaps in — landing
// the user on Home without SetupPage having to navigate across the remount. Re-running the wizard
// on purpose stays possible via /setup?rerun=1.
function SetupWhenComplete() {
  const [params] = useSearchParams();
  return params.get('rerun') ? <SetupPage /> : <Navigate to="/" replace />;
}
