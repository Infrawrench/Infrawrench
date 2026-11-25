import { SettingsSection } from "../../components/SideNav";
import { LabelsManager } from "../labels/LabelsManager";
import { MilestonesManager } from "../milestones/MilestonesManager";

export function LabelsSettingsPage() {
  return (
    <SettingsSection title="Labels">
      <LabelsManager />
    </SettingsSection>
  );
}

export function MilestonesSettingsPage() {
  return (
    <SettingsSection title="Milestones">
      <MilestonesManager />
    </SettingsSection>
  );
}
