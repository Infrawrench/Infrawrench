# Desktop ↔ Web Parity Audit

## Summary

Audited all components across `app/packages/desktop/` and `app/packages/web/` to ensure 1:1 visual and functional parity (minus platform-specific features like Electron IPC, native file dialogs, and macOS title bar).

---

## Changes Made

### 1. KvConsole — Extracted to shared UI
- **Before**: Desktop and web each had their own ~160-line KvConsole component with duplicated UI code
- **After**: Single shared `@infrawrench/ui` KvConsole with `onCommand` callback pattern. Desktop and web are now 14-line thin wrappers
- **Parity fix**: Desktop's connection status indicator (`connected` prop) is now available to web too. Web's multi-driver label (Redis/Memcached/MongoDB) is now used by desktop too

### 2. MongoDocumentBrowser — Extracted to shared UI
- **Before**: ~490 lines duplicated across desktop and web, 95% identical
- **After**: Single shared `@infrawrench/ui` MongoDocumentBrowser with `onCommand` callback. Desktop and web are 14-line wrappers
- **Parity fix**: Desktop's "Connecting to MongoDB..." state (via `connected` prop) is now available to web

### 3. DashboardView — Aligned web with desktop
- **Before**: Web had fixed 3-column grid, bare cards (just name + raw pluginId text), no plugin logos
- **After**: Web matches desktop's responsive grid (`auto-fill, minmax(220px, 1fr)`) with plugin logo SVGs, plugin display names, and host info extracted from fieldsJson
- **API enrichment**: Dashboard API endpoints now return `pluginLogoSvg` and `pluginDisplayName` alongside pins

### 4. SshQuickConnectPanel — Aligned web with desktop
- **Before**: Web's connect button said just "Connect", no username auto-derivation from key selection
- **After**: Web now shows keyboard icon in button (matching desktop), auto-derives username from SSH key owner on selection and on initial load

### 5. SpotlightSearch (⌘K) — Added to web
- **Before**: Desktop had SpotlightSearch for ⌘K resource search; web had nothing
- **After**: Web now has full SpotlightSearch with identical UI: grouped results by plugin, keyboard navigation (↑↓/Enter/Esc), plugin logos, resource type labels
- **New API**: `GET /api/search?q=...` endpoint for server-side resource search
- **Shortcut**: ⌘K / Ctrl+K registered in web root layout

---

## Already at Parity (no changes needed)

| Component | Notes |
|-----------|-------|
| AddAccountModal | Both wrap shared `@infrawrench/ui` component. Only backend integration differs |
| DockerActionsPanel | Both wrap shared `@infrawrench/ui` component |
| DetailView | Both use shared component from `@infrawrench/ui` |
| ConfirmDeleteModal | Both use shared component |
| CreateResourceModal | Both use shared FieldRenderer. Desktop has pricing UI, web has SSH key UI — both are platform-appropriate |
| SchemaRenderer | Shared component |
| DashboardCard/Grid | Shared components |
| SidebarSection/Item | Shared components |

---

## Intentional Platform Differences (not parity gaps)

These are correct divergences — the web cannot/should not replicate these:

| Feature | Desktop | Web | Why |
|---------|---------|-----|-----|
| SSH terminal | Native ssh2 via IPC | WebSocket proxy via WebTerminal | Browser can't do native SSH |
| SFTP transfers | Native with progress callbacks | FormData upload, URL download | Browser can't do native SFTP |
| Storage download | Batch download to folder dialog | Direct URL download | No native file dialogs in browser |
| macOS title bar | Custom drag region | Standard browser chrome | Electron-only |
| Swipe gestures | Trackpad back/forward | Browser handles natively | Electron-only |
| SSH tunnels/Docker setup | SshTunnelModal, DockerSetupModal | Not applicable | Requires local port binding |
| Secret drops | Drag credentials onto K8s clusters | Not applicable | Requires local IPC |
| System SSH keys | Reads ~/.ssh/ | Server-managed SSH keys | Browser can't access filesystem |
| Create pricing | Real-time cost estimation | Not implemented | Requires plugin API calls client-side |
| K9s terminal | Native k9s process | Not applicable | Requires local binary |
| Cloud sync settings | CloudSettingsPanel | N/A (web IS the cloud) | Desktop-only feature |
| Data persistence | Local SQLite | Server PostgreSQL | Architecture difference |

---

## File Changes

### New files
- `app/packages/ui/src/components/KvConsole.tsx` — shared KvConsole
- `app/packages/ui/src/components/MongoDocumentBrowser.tsx` — shared MongoDocumentBrowser
- `app/packages/web/src/components/SpotlightSearch.tsx` — web SpotlightSearch
- `app/packages/web/src/api/routes/search.ts` — search API endpoint

### Modified files
- `app/packages/ui/src/index.ts` — exports for new shared components
- `app/packages/desktop/src/components/KvConsole.tsx` — now wraps shared
- `app/packages/desktop/src/components/MongoDocumentBrowser.tsx` — now wraps shared
- `app/packages/web/src/components/KvConsole.tsx` — now wraps shared
- `app/packages/web/src/components/MongoDocumentBrowser.tsx` — now wraps shared
- `app/packages/web/src/components/DashboardView.tsx` — responsive grid + plugin info
- `app/packages/web/src/components/SshQuickConnectPanel.tsx` — username derivation + icon
- `app/packages/web/src/api/routes/dashboards.ts` — enrichPins with plugin metadata
- `app/packages/web/src/api/index.ts` — registered search route
- `app/packages/web/src/routes/__root.tsx` — ⌘K shortcut + SpotlightSearch
