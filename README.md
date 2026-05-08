# GitHub Team Metrics Dashboard

A local HTML/CSS/JS dashboard for visualizing GitHub team performance metrics.

## Setup

1. Unzip the folder
2. Open `index.html` in your browser (Chrome, Firefox, Edge, Safari)
3. No server needed — runs entirely in your browser

## Usage

1. Generate a GitHub Personal Access Token at:
   https://github.com/settings/tokens
   
   Required scopes:
   - `repo` (to read private repository data)
   - `read:org` (to list organization repositories)

2. Paste your token in the **Personal Access Token** field
3. Enter your organization name (e.g. `SAVASPOULTRYADVISING`)
4. Select the time period
5. Click **Load Metrics**

## What it shows

- **Summary cards** — total commits, lines added/removed, net change, repo count, contributor count
- **Monthly commit activity** — line chart of commit volume over time
- **Lines of code per contributor** — horizontal bar chart (additions vs deletions)
- **Contributor breakdown table** — commits, +added, −removed, net change, active repos
- **Repository overview** — all repos with language, stars, forks, issues, last updated

## Security

- Your token is never sent anywhere except directly to `api.github.com`
- No backend, no tracking, no external services
- Token is stored only in the input field (not persisted to localStorage)
- Revoke tokens at https://github.com/settings/tokens after use
