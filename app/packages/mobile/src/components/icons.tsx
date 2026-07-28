import Svg, { Circle, Path, Rect } from "react-native-svg";

/**
 * Line icons for the tab bar and navigation chrome.
 *
 * Unicode glyphs (⌂ ▤ ⚙ …) are not icons: the OS picks the font, so weights are
 * inconsistent between them and some — the gear especially — resolve to a full
 * colour emoji that ignores `color`. These are drawn instead, on the same 24×24
 * stroke grid the web app's `WorkflowIcon` uses, so the two stay visually in
 * step. `react-native-svg` is already a dependency; nothing new is pulled in.
 */
export interface IconProps {
  color: string;
  size?: number;
}

function Icon({ color, size = 24, children }: IconProps & { children: React.ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

/** Panels of a dashboard grid — the tab lists dashboards, so a house would lie. */
export function DashboardsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Rect x="3" y="3" width="7" height="9" rx="1" />
      <Rect x="14" y="3" width="7" height="5" rx="1" />
      <Rect x="14" y="12" width="7" height="9" rx="1" />
      <Rect x="3" y="16" width="7" height="5" rx="1" />
    </Icon>
  );
}

/** Back chevron for screens pushed over a tab (they get no back button of their own). */
export function BackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M15 5l-7 7 7 7" />
    </Icon>
  );
}

export function ResourcesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M12 2.5 21.5 7 12 11.5 2.5 7z" />
      <Path d="M2.5 12 12 16.5 21.5 12" />
      <Path d="M2.5 17 12 21.5 21.5 17" />
    </Icon>
  );
}

/** Matches the web app's `CostsIcon` — same bars, same 24×24 grid. */
export function CostsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <Path d="M8 11h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" />
      <Path d="M16 7h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <Path d="M12 6.5 13 9l2.5 1-2.5 1-1 2.5-1-2.5L8.5 10 11 9z" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Circle cx={11} cy={11} r={7} />
      <Path d="m20 20-3.9-3.9" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <Circle cx={12} cy={12} r={3} />
    </Icon>
  );
}

export function SwitchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="m8 3-4 4 4 4" />
      <Path d="M4 7h16" />
      <Path d="m16 21 4-4-4-4" />
      <Path d="M20 17H4" />
    </Icon>
  );
}

/** Selected entry in a picker sheet. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="m5 13 4 4L19 7" />
    </Icon>
  );
}

/* Transport controls for the Speech screen's audio players and recorder. */

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M8 5.5v13l11-6.5z" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M9.5 5v14" />
      <Path d="M14.5 5v14" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Rect x="6" y="6" width="12" height="12" rx="2" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
      <Path d="M19 11v1a7 7 0 0 1-14 0v-1" />
      <Path d="M12 19v3" />
    </Icon>
  );
}
