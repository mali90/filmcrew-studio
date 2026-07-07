// Settings — one calm column: keys, render defaults, doctor checks, storage, about.
import { KeysCard } from '../components/settings/KeysCard';
import { DefaultsCard } from '../components/settings/DefaultsCard';
import { HealthCard } from '../components/settings/HealthCard';
import { StorageCard } from '../components/settings/StorageCard';
import { ApplicationCard } from '../components/settings/ApplicationCard';
import { AboutCard } from '../components/settings/AboutCard';

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-[720px]">
      <header>
        <h1 className="text-display text-ink">Settings</h1>
        <p className="mt-1 text-body text-ink-secondary">Keys, render defaults and the health of your toolchain.</p>
      </header>
      <div className="mt-8 space-y-4">
        <KeysCard />
        <DefaultsCard />
        <HealthCard />
        <StorageCard />
        <ApplicationCard />
        <AboutCard />
      </div>
    </div>
  );
}
