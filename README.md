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

Two views, each with a **Weekly / Monthly** toggle:

**Overall contributions**
- **Summary cards** — team members, commits, lines added/removed, net contribution, repos
- **Team output over time** — additions (up) vs deletions (down) per period, with net as a line
- **Cumulative net contribution** — running total of net lines (the codebase growth trajectory)
- **Repository overview** — all repos with language, stars, forks, issues, last updated

**Net by team member**
- **Heatmap** — net contribution of every team member × period on a diverging red→green scale,
  with per-member and team totals — the clearest read of who contributed what, when
- **Per-member breakdown** — net-per-period sparkline (shared scale), commits, +added, −removed,
  net and active repos, sorted by net contribution

## How the numbers are computed (data accuracy)

- **Attributed to the commit _author_** (who wrote the code), never the committer (who recorded
  it — often a rebase/merge/bot). See the [GraphQL Commit reference](https://docs.github.com/en/graphql/reference/commits).
- **Read across all branches and de-duplicated by SHA**, so a commit that lives on a feature
  branch and on `main` is counted once.
- **Merge commits excluded** (`parents > 1`) — their additions/deletions duplicate the merged
  branch and would inflate line counts.
- **Bot accounts excluded** (`*[bot]`, dependabot, github-actions, renovate, …).
- **Team, not committer:** commits are grouped by person, merging alternate email/name identities
  into one GitHub handle via a two-pass resolution pass.
- **Net contribution = additions − deletions.**

## Security

- Your token is never sent anywhere except directly to `api.github.com`
- No backend, no tracking, no external services
- Token is stored only in the input field (not persisted to localStorage)
- Revoke tokens at https://github.com/settings/tokens after use
