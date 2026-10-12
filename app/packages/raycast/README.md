# Infrawrench for Raycast

- **Search Resources**: resources across every connected account and your services, with 30-day cost, status, Terraform state, owning service, open posture findings and open incidents in the detail pane. Open in the web or desktop app, copy ids and links, or declare an incident affecting a resource or a whole service.
- **Who Is On Call**: every rotation's current person, when they hand off, and who is next.
- **Open Incidents**: open and mitigated incidents, worst first.
- **Declare Incident**: title, severity and summary, confirmed before anything is sent.

## Setup

1. In Infrawrench, create an API key under Settings > API keys. The commands need `resources:read`, `costs:read`, `iac:read`, `incidents:read`, `team:read`, and `incidents:write` to declare.
2. Paste the key into the extension's **API Key** preference.
3. For **Organization**, paste any Infrawrench address from inside your organization (the API keys page works), or the organization id.

"Open in Desktop App" uses the desktop app's `infrawrench://` links; the desktop app must be signed in to the same organization.
