'use strict';

/*
 * GitHub Team Metrics — data & rendering
 *
 * Attribution model (see README):
 *   • Work is attributed to the commit AUTHOR (who wrote the code), never the
 *     committer (who recorded it — often a rebase/merge/bot). GitHub GraphQL
 *     exposes both; `author.user.login` is the linked account.
 *   • Commits are read across ALL branches and de-duplicated by SHA (oid), so a
 *     commit that lives on a feature branch and on main is counted once.
 *   • Merge commits (parents > 1) are excluded — their additions/deletions
 *     duplicate the branch they merge, which would inflate line counts.
 *   • Bot accounts are excluded.
 *   • Net contribution = additions − deletions.
 */

// ── App state ────────────────────────────────────────────────────────────────
// `var` (not `let`) so these singletons are reachable on the global object for
// debugging in the browser console; behaviour is otherwise identical.
var RAW = null;            // { records, memberMeta, repos, sinceISO, days, org }
var DATA = null;           // aggregated view for the current granularity
var granularity = 'week';  // 'week' | 'month'
var activeView = 'overview';
var charts = [];
var cancelled = false;
var lastParams = null;

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => { const el = $(id); if (el) el.style.display = ''; };
const hide = id => { const el = $(id); if (el) el.style.display = 'none'; };

function setProgress(label, pct) {
  $('progressLabel').textContent = label;
  $('progressBar').style.width = Math.min(100, pct) + '%';
}
function showError(msg) {
  $('errorBanner').style.display = 'block';
  $('errorBanner').innerHTML = '⚠️ ' + escHtml(msg);
}
function clearError() {
  hide('errorBanner');
  $('errorBanner').innerHTML = '';
}
function toggleToken() {
  const inp = $('token');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}
function cancelLoad() { cancelled = true; }
function reload() {
  if (lastParams) loadMetrics(lastParams.token, lastParams.org, lastParams.days);
}

// ── GitHub API ───────────────────────────────────────────────────────────────
async function ghFetch(path, token) {
  if (cancelled) throw new Error('Cancelled');
  const r = await fetch('https://api.github.com' + path, {
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error('GitHub ' + r.status + ': ' + (body.message || path));
  }
  return r.json();
}

async function getAllPages(path, token) {
  let results = [], page = 1;
  while (true) {
    if (cancelled) throw new Error('Cancelled');
    const sep = path.includes('?') ? '&' : '?';
    const data = await ghFetch(path + sep + 'per_page=100&page=' + page, token);
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

async function ghGraphQL(query, variables, token) {
  if (cancelled) throw new Error('Cancelled');
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': 'bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors) {
    const msg = (body.errors && body.errors[0] && body.errors[0].message) || ('HTTP ' + r.status);
    throw new Error('GraphQL ' + r.status + ': ' + msg);
  }
  return body.data;
}

async function fetchAllBranchRefNames(owner, name, token) {
  const query = `
    query($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        refs(first: 100, refPrefix: "refs/heads/", after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }`;
  const names = [];
  let cursor = null;
  while (true) {
    if (cancelled) throw new Error('Cancelled');
    const data = await ghGraphQL(query, { owner, name, cursor }, token);
    const refs = data && data.repository && data.repository.refs;
    if (!refs || !refs.nodes || !refs.nodes.length) break;
    for (const n of refs.nodes) if (n && n.name) names.push('refs/heads/' + n.name);
    if (!refs.pageInfo || !refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
  }
  return names;
}

async function fetchDefaultBranchQualifiedName(owner, name, token) {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { defaultBranchRef { qualifiedName } }
    }`;
  if (cancelled) throw new Error('Cancelled');
  const data = await ghGraphQL(query, { owner, name }, token);
  const q = data && data.repository && data.repository.defaultBranchRef && data.repository.defaultBranchRef.qualifiedName;
  return q ? [q] : [];
}

/** Commits across all branches, de-duplicated by oid. Includes merge flag. */
async function fetchRepoCommitsWithStats(org, repoName, sinceISO, token) {
  const historyQuery = `
    query($owner: String!, $name: String!, $since: GitTimestamp!, $qualifiedRef: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        ref(qualifiedName: $qualifiedRef) {
          target {
            ... on Commit {
              history(first: 100, since: $since, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  oid
                  additions
                  deletions
                  committedDate
                  parents { totalCount }
                  author { user { login avatarUrl } email name }
                }
              }
            }
          }
        }
      }
    }`;

  let refNames = await fetchAllBranchRefNames(org, repoName, token);
  if (!refNames.length) refNames = await fetchDefaultBranchQualifiedName(org, repoName, token);
  if (!refNames.length) return [];

  const byOid = new Map();
  for (const qualifiedRef of refNames) {
    let after = null;
    while (true) {
      if (cancelled) throw new Error('Cancelled');
      const data = await ghGraphQL(historyQuery, { owner: org, name: repoName, since: sinceISO, qualifiedRef, after }, token);
      const refObj = data && data.repository && data.repository.ref;
      const hist = refObj && refObj.target && refObj.target.history;
      if (!hist || !hist.nodes) break;
      for (const n of hist.nodes) {
        if (!n || !n.oid || byOid.has(n.oid)) continue;
        const a = n.author || {};
        const user = a.user;
        byOid.set(n.oid, {
          githubLogin: (user && user.login) || '',
          avatar: (user && user.avatarUrl) || '',
          email: a.email || '',
          name: a.name || '',
          additions: n.additions || 0,
          deletions: n.deletions || 0,
          committedDate: n.committedDate || '',
          isMerge: !!(n.parents && n.parents.totalCount > 1),
          repo: repoName
        });
      }
      if (!hist.pageInfo || !hist.pageInfo.hasNextPage) break;
      after = hist.pageInfo.endCursor;
    }
  }
  return Array.from(byOid.values());
}

// ── Identity resolution (person, not raw committer) ──────────────────────────
function emailLocalPart(s) {
  const v = (s || '').trim();
  if (!v) return '';
  const at = v.indexOf('@');
  return at === -1 ? v : v.slice(0, at);
}

function normalizeIdentityKey(s) {
  const v = (s || '').trim().toLowerCase();
  if (!v) return '';
  // Treat separators as equivalent: brahim-elkaceh == brahimelkaceh
  return v.replace(/[^a-z0-9]/g, '');
}

/** Merge org-style logins ending in "savas" into the base handle (ahmederrajaaisavas → ahmederrajaai). */
function canonicalContributorLogin(login) {
  const s = String(login || '').trim();
  if (!s || s === 'unknown') return s;
  const lower = s.toLowerCase();
  const suf = 'savas';
  if (lower.endsWith(suf) && lower.length > suf.length) {
    let base = s.slice(0, -suf.length);
    if (base.endsWith('-')) base = base.slice(0, -1);
    return base || s;
  }
  return s;
}

const BOT_LOGINS = new Set(['dependabot', 'dependabot-preview', 'github-actions', 'renovate', 'renovate-bot', 'snyk-bot', 'codecov-commenter', 'imgbot', 'web-flow']);
function isBotIdentity(login, name) {
  const l = (login || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (/\[bot\]$/.test(l) || /\[bot\]$/.test(n)) return true;
  if (BOT_LOGINS.has(l)) return true;
  return false;
}

/**
 * Two-pass author→member resolution.
 * Pass 1 learns every email/name/login alias for accounts that carry a GitHub
 * login, so pass 2 attributes commits consistently regardless of the order they
 * were fetched in (the previous single-pass version mis-attributed early
 * commits whose alias had not been seen yet).
 */
function resolveMembers(commits) {
  const aliasToLogin = {};
  for (const c of commits) {
    const ghLogin = (c.githubLogin || '').trim();
    if (!ghLogin) continue;
    const canon = canonicalContributorLogin(ghLogin);
    const emailKey = normalizeIdentityKey(emailLocalPart(c.email));
    const nameKey = normalizeIdentityKey(c.name);
    const ghKey = normalizeIdentityKey(ghLogin);
    if (emailKey) aliasToLogin[emailKey] = canon;
    if (nameKey) aliasToLogin[nameKey] = canon;
    if (ghKey) aliasToLogin[ghKey] = canon;
    const baseKey = normalizeIdentityKey(canon);
    if (baseKey) aliasToLogin[baseKey] = canon; // link base handle to canonical
  }

  const records = [];
  const memberMeta = {};
  for (const c of commits) {
    if (c.isMerge) continue; // exclude merge commits from line stats
    const ghLogin = (c.githubLogin || '').trim();
    const emailLocal = emailLocalPart(c.email).trim();
    const nameRaw = (c.name || '').trim();
    if (isBotIdentity(ghLogin, nameRaw)) continue;

    const emailKey = normalizeIdentityKey(emailLocal);
    const nameKey = normalizeIdentityKey(nameRaw);
    const member = canonicalContributorLogin(
      ghLogin ||
      (emailKey && aliasToLogin[emailKey]) ||
      (nameKey && aliasToLogin[nameKey]) ||
      emailLocal || nameRaw || 'unknown'
    );

    if (!memberMeta[member]) memberMeta[member] = { avatar: c.avatar || '' };
    else if (c.avatar && !memberMeta[member].avatar) memberMeta[member].avatar = c.avatar;

    records.push({ member, a: c.additions, d: c.deletions, date: c.committedDate, repo: c.repo });
  }
  return { records, memberMeta };
}

// ── Period helpers ───────────────────────────────────────────────────────────
function startOfWeekISO(isoDate) {
  const d = new Date(isoDate);
  const day = d.getUTCDay();               // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;   // back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function monthKey(isoDate) { return String(isoDate).slice(0, 7); }
function periodKeyOf(isoDate, gran) { return gran === 'month' ? monthKey(isoDate) : startOfWeekISO(isoDate); }

function enumerateWeeks(sinceISO) {
  const out = [];
  const cur = new Date(startOfWeekISO(sinceISO) + 'T00:00:00Z');
  const endMs = Date.now();
  while (cur.getTime() <= endMs) {
    const key = cur.toISOString().slice(0, 10);
    out.push({ key, label: new Date(key + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) });
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}
function enumerateMonths(sinceISO) {
  const out = [];
  const s = new Date(sinceISO);
  const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
  const now = new Date();
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  while (cur.getTime() <= endMs) {
    const key = cur.toISOString().slice(0, 7);
    out.push({ key, label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }) });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}
function enumeratePeriods(sinceISO, gran) {
  return gran === 'month' ? enumerateMonths(sinceISO) : enumerateWeeks(sinceISO);
}

// ── Aggregation (re-runs when granularity toggles; no refetch) ───────────────
function aggregate(raw, gran) {
  const periods = enumeratePeriods(raw.sinceISO, gran);
  const pIndex = new Map(periods.map((p, i) => [p.key, i]));
  const emptyRow = () => periods.map(() => ({ a: 0, d: 0, commits: 0 }));

  const memberMap = new Map();
  const overall = periods.map(() => ({ a: 0, d: 0, commits: 0, members: new Set() }));
  let totA = 0, totD = 0, totC = 0;

  for (const r of raw.records) {
    let m = memberMap.get(r.member);
    if (!m) {
      m = { member: r.member, avatar: (raw.memberMeta[r.member] || {}).avatar || '', a: 0, d: 0, commits: 0, repos: new Set(), byPeriod: emptyRow() };
      memberMap.set(r.member, m);
    }
    m.a += r.a; m.d += r.d; m.commits++; m.repos.add(r.repo);
    totA += r.a; totD += r.d; totC++;

    const pi = pIndex.get(periodKeyOf(r.date, gran));
    if (pi !== undefined) {
      m.byPeriod[pi].a += r.a; m.byPeriod[pi].d += r.d; m.byPeriod[pi].commits++;
      overall[pi].a += r.a; overall[pi].d += r.d; overall[pi].commits++; overall[pi].members.add(r.member);
    }
  }

  const members = [...memberMap.values()].map(m => ({
    member: m.member, avatar: m.avatar, a: m.a, d: m.d, net: m.a - m.d, commits: m.commits,
    repos: [...m.repos], activePeriods: m.byPeriod.filter(p => p.commits > 0).length,
    byPeriod: m.byPeriod.map(p => ({ a: p.a, d: p.d, net: p.a - p.d, commits: p.commits }))
  })).sort((x, y) => (y.net - x.net) || (y.commits - x.commits) || x.member.localeCompare(y.member));

  const overallOut = overall.map(o => ({ a: o.a, d: o.d, net: o.a - o.d, commits: o.commits, activeMembers: o.members.size }));

  return { periods, members, overall: overallOut, totals: { a: totA, d: totD, net: totA - totD, commits: totC } };
}

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtInt(n) { return Number(n || 0).toLocaleString(); }
function fmtSigned(n) { return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString(); }
function fmtCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1000) return (n < 0 ? '−' : '') + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'k';
  return String(n);
}
function fmtSignedCompact(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtCompact(Math.abs(n)); }
function escHtml(str) {
  if (str === 0) return '0';
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  if (days < 365) return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'yr ago';
}

// ── Main loader ──────────────────────────────────────────────────────────────
async function loadMetrics(token, org, days) {
  cancelled = false;
  lastParams = { token, org, days };
  granularity = days <= 120 ? 'week' : 'month';
  clearError();

  hide('dashboard'); hide('teamView'); hide('emptyState'); hide('sidebarNav'); hide('sidebarStats');
  show('progress');
  $('loadBtn').disabled = true;
  setProgress('Connecting to GitHub…', 5);

  const SINCE = new Date(Date.now() - days * 864e5).toISOString();

  try {
    const me = await ghFetch('/user', token);
    setProgress('Authenticated as ' + me.login, 10);

    setProgress('Loading repositories…', 15);
    let repos = [];
    try {
      repos = await getAllPages('/orgs/' + org + '/repos', token);
    } catch (e) {
      try { repos = await getAllPages('/users/' + org + '/repos', token); }
      catch (e2) { throw new Error('Cannot find org or user "' + org + '". ' + e.message); }
    }
    if (!repos.length) throw new Error('No repositories found in ' + org);

    repos = repos.filter(r => !r.name.endsWith('_build'));
    if (!repos.length) throw new Error('No repositories found in ' + org + ' after filtering');
    repos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    // Collect raw commits across all repos, then resolve identities in one pass.
    const allCommits = [];
    const total = repos.length;
    for (let i = 0; i < repos.length; i++) {
      if (cancelled) throw new Error('Cancelled');
      const repo = repos[i];
      setProgress('Repo (' + (i + 1) + '/' + total + '): ' + repo.name, 15 + (i / total) * 70);
      try {
        const commits = await fetchRepoCommitsWithStats(org, repo.name, SINCE, token);
        for (const c of commits) allCommits.push(c);
      } catch (e) { /* skip empty/inaccessible repo */ }
    }

    setProgress('Resolving contributors…', 88);
    const { records, memberMeta } = resolveMembers(allCommits);

    RAW = {
      records, memberMeta,
      repos: repos.map(r => ({
        name: r.name, description: r.description, language: r.language,
        stargazers_count: r.stargazers_count, forks_count: r.forks_count,
        open_issues_count: r.open_issues_count, updated_at: r.updated_at, html_url: r.html_url
      })),
      sinceISO: SINCE, days, org
    };

    setProgress('Rendering…', 94);
    renderAll();
  } catch (e) {
    hide('progress');
    $('loadBtn').disabled = false;
    if (e.message !== 'Cancelled') { showError(e.message); show('emptyState'); }
  }
}

// ── Render orchestration ─────────────────────────────────────────────────────
const CHART_COLORS = ['#58a6ff', '#3fb950', '#f85149', '#bc8cff', '#d29922', '#79c0ff', '#ffa657', '#ff7b72', '#a5d6ff', '#7ee787'];
const GREEN = [63, 185, 80], RED = [248, 81, 73];

function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

function renderAll() {
  if (!RAW) return;
  DATA = aggregate(RAW, granularity);

  hide('progress'); hide('emptyState');
  $('loadBtn').disabled = false;

  const subtitle = 'Last ' + RAW.days + ' days · ' + RAW.repos.length + ' repos · ' +
    DATA.members.length + ' team members · by ' + granularity;
  $('dashTitle').textContent = RAW.org;
  $('dashSubtitle').textContent = subtitle;
  $('teamTitle').textContent = RAW.org;
  $('teamSubtitle').textContent = subtitle;

  renderKPIs();
  renderTeam();       // DOM/SVG — safe to build while hidden
  renderRepos();
  syncGranButtons();

  show('sidebarNav'); show('sidebarStats');
  setActiveView(activeView);
}

function setActiveView(view) {
  if (!DATA) return;
  activeView = view;
  document.querySelectorAll('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.view === view));

  destroyCharts();
  if (view === 'overview') { show('dashboard'); hide('teamView'); renderOverviewCharts(); }
  else { hide('dashboard'); show('teamView'); }
}

function setGranularity(g) {
  if (g === granularity) return;
  granularity = g;
  renderAll();
}
function syncGranButtons() {
  document.querySelectorAll('.gran-btn').forEach(b => b.classList.toggle('active', b.dataset.gran === granularity));
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
function renderKPIs() {
  const t = DATA.totals;
  const cards = [
    { label: 'Team Members', value: fmtInt(DATA.members.length), icon: '👥' },
    { label: 'Commits', value: fmtInt(t.commits), icon: '📝', sub: 'excl. merges' },
    { label: 'Lines Added', value: '+' + fmtInt(t.a), icon: '🟢', cls: 'green' },
    { label: 'Lines Removed', value: '−' + fmtInt(t.d), icon: '🔴', cls: 'red' },
    { label: 'Net Contribution', value: fmtSigned(t.net), icon: '📊', cls: t.net >= 0 ? 'green' : 'red' },
    { label: 'Repositories', value: fmtInt(RAW.repos.length), icon: '📁' },
  ];
  $('metricGrid').innerHTML = cards.map(m => `
    <div class="metric-card">
      <div class="m-icon">${m.icon}</div>
      <div class="m-label">${m.label}</div>
      <div class="m-value${m.cls ? ' ' + m.cls : ''}">${m.value}</div>
      ${m.sub ? `<div class="m-sub">${m.sub}</div>` : ''}
    </div>`).join('');

  $('sidebarStats').innerHTML = cards.map(m => `
    <div class="stat-row"><span class="stat-label">${m.label}</span><span class="stat-val">${m.value}</span></div>`).join('');
}

// ── Overview charts (goal 2: overall contributions) ──────────────────────────
function renderOverviewCharts() {
  const labels = DATA.periods.map(p => p.label);
  const adds = DATA.overall.map(o => o.a);
  const dels = DATA.overall.map(o => -o.d);   // below zero
  const nets = DATA.overall.map(o => o.net);

  // Team output over time: additions up / deletions down + net line
  const outCtx = $('outputChart').getContext('2d');
  charts.push(new Chart(outCtx, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Additions', data: adds, backgroundColor: 'rgba(63,185,80,0.75)', borderRadius: 3, stack: 'loc', order: 2 },
        { type: 'bar', label: 'Deletions', data: dels, backgroundColor: 'rgba(248,81,73,0.75)', borderRadius: 3, stack: 'loc', order: 2 },
        { type: 'line', label: 'Net', data: nets, borderColor: '#58a6ff', backgroundColor: '#58a6ff', tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, order: 1 }
      ]
    },
    options: baseChartOpts({
      // parsed.y already carries the right sign for each series (additions +,
      // deletions plotted negative, net signed), so format it directly.
      stacked: true,
      tooltip: ctx => ctx.dataset.label + ': ' + fmtSigned(ctx.parsed.y)
    })
  }));

  // Cumulative net — codebase growth trajectory
  let run = 0;
  const cum = nets.map(v => (run += v));
  const cumCtx = $('cumulativeChart').getContext('2d');
  charts.push(new Chart(cumCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative net', data: cum, borderColor: '#bc8cff',
        backgroundColor: 'rgba(188,140,255,0.12)', fill: true, tension: 0.3,
        pointRadius: 3, pointHoverRadius: 5, borderWidth: 2
      }]
    },
    options: baseChartOpts({ legend: false, tooltip: ctx => 'Cumulative net: ' + fmtSigned(ctx.parsed.y) })
  }));
}

function baseChartOpts({ stacked = false, legend = true, tooltip } = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: legend ? { display: true, position: 'top', labels: { color: '#8b949e', font: { size: 12 }, boxWidth: 12, boxHeight: 12, usePointStyle: true } } : { display: false },
      tooltip: { mode: 'index', intersect: false, callbacks: tooltip ? { label: tooltip } : {} }
    },
    scales: {
      x: { stacked, ticks: { color: '#6e7681', font: { size: 11 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 16 }, grid: { color: '#21262d' } },
      y: { stacked, ticks: { color: '#6e7681', font: { size: 11 }, callback: v => fmtCompact(v) }, grid: { color: '#21262d', zeroLineColor: '#484f58' } }
    }
  };
}

// ── Team views (goal 1: net contribution per member by period) ───────────────
function renderTeam() {
  renderHeatmap();
  renderLeaderboard();
  $('teamNote').innerHTML = 'Net = additions − deletions, attributed to the commit <strong>author</strong>. ' +
    'Merge commits and bots excluded · commits de-duplicated across all branches. Colour intensity is relative to the largest net cell.';
}

function heatColor(v, maxAbs) {
  if (!v || !maxAbs) return { bg: 'transparent', fg: 'var(--text3)' };
  const t = Math.min(1, Math.sqrt(Math.abs(v) / maxAbs)); // perceptual-ish
  const [r, g, b] = v > 0 ? GREEN : RED;
  const alpha = 0.10 + 0.80 * t;
  return { bg: `rgba(${r},${g},${b},${alpha.toFixed(3)})`, fg: t > 0.55 ? '#0d1117' : 'var(--text)' };
}

function renderHeatmap() {
  const { periods, members, overall } = DATA;
  const wrap = $('heatmap');
  if (!members.length || !periods.length) { wrap.innerHTML = '<p class="empty-note">No contribution data in this period.</p>'; return; }

  let maxAbs = 0;
  for (const m of members) for (const p of m.byPeriod) maxAbs = Math.max(maxAbs, Math.abs(p.net));

  const head = '<tr><th class="hm-corner">Team member</th>' +
    periods.map(p => `<th class="hm-period">${escHtml(p.label)}</th>`).join('') +
    '<th class="hm-total-h">Total</th></tr>';

  const rows = members.map(m => {
    const cells = m.byPeriod.map((p, i) => {
      const c = heatColor(p.net, maxAbs);
      const title = `${m.member} · ${periods[i].label}\n${fmtSigned(p.net)} net  (+${fmtInt(p.a)} / −${fmtInt(p.d)})  ·  ${p.commits} commit${p.commits === 1 ? '' : 's'}`;
      const txt = p.commits ? fmtSignedCompact(p.net) : '';
      return `<td class="hm-cell" style="background:${c.bg};color:${c.fg}" title="${escHtml(title)}">${txt}</td>`;
    }).join('');
    const netCls = m.net >= 0 ? 'green' : 'red';
    return `<tr>
      <th class="hm-member">
        <span class="avatar sm">${m.avatar ? `<img src="${escHtml(m.avatar)}" alt="" loading="lazy"/>` : escHtml(m.member.slice(0, 2).toUpperCase())}</span>
        <span class="hm-name" title="${escHtml(m.member)}">${escHtml(m.member)}</span>
      </th>
      ${cells}
      <td class="hm-total ${netCls}">${fmtSigned(m.net)}</td>
    </tr>`;
  }).join('');

  const footCells = overall.map((o, i) => {
    const c = heatColor(o.net, maxAbs);
    return `<td class="hm-cell strong" style="background:${c.bg};color:${c.fg}" title="${escHtml('Team · ' + periods[i].label + '\n' + fmtSigned(o.net) + ' net · ' + o.commits + ' commits')}">${o.commits ? fmtSignedCompact(o.net) : ''}</td>`;
  }).join('');
  const grand = DATA.totals.net;
  const foot = `<tr class="hm-foot"><th class="hm-member">Team total</th>${footCells}<td class="hm-total ${grand >= 0 ? 'green' : 'red'}">${fmtSigned(grand)}</td></tr>`;

  wrap.innerHTML = `<div class="heatmap-scroll"><table class="heatmap"><thead>${head}</thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div>`;
}

/** Inline SVG bar sparkline of net per period, on a shared scale so members compare. */
function sparkline(byPeriod, maxAbs) {
  const n = byPeriod.length;
  const W = 132, H = 34, gap = 1;
  const bw = Math.max(1, (W - (n - 1) * gap) / n);
  const mid = H / 2;
  const scale = maxAbs ? (H / 2 - 2) / maxAbs : 0;
  let bars = '';
  byPeriod.forEach((p, i) => {
    const x = i * (bw + gap);
    if (!p.commits) { bars += `<rect x="${x.toFixed(2)}" y="${mid - 0.5}" width="${bw.toFixed(2)}" height="1" fill="var(--border)"/>`; return; }
    const h = Math.max(1, Math.abs(p.net) * scale);
    const y = p.net >= 0 ? mid - h : mid;
    const fill = p.net >= 0 ? 'var(--green)' : 'var(--red)';
    bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" rx="0.5"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--border)" stroke-width="0.5"/>${bars}</svg>`;
}

function renderLeaderboard() {
  const { members } = DATA;
  let maxAbs = 0;
  for (const m of members) for (const p of m.byPeriod) maxAbs = Math.max(maxAbs, Math.abs(p.net));

  $('leaderBody').innerHTML = members.map((m, i) => {
    const netCls = m.net >= 0 ? 'green' : 'red';
    const initials = m.member.slice(0, 2).toUpperCase();
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td>
        <div class="contributor-name">
          <span class="avatar">${m.avatar ? `<img src="${escHtml(m.avatar)}" alt="" loading="lazy"/>` : initials}</span>
          <span class="hm-name" title="${escHtml(m.member)}">${escHtml(m.member)}</span>
        </div>
      </td>
      <td class="spark-cell">${sparkline(m.byPeriod, maxAbs)}</td>
      <td class="num">${fmtInt(m.commits)}</td>
      <td class="num green">+${fmtInt(m.a)}</td>
      <td class="num red">−${fmtInt(m.d)}</td>
      <td class="num ${netCls} strong">${fmtSigned(m.net)}</td>
      <td class="num muted">${m.repos.length}</td>
    </tr>`;
  }).join('');
}

// ── Repositories ─────────────────────────────────────────────────────────────
function renderRepos() {
  $('repoGrid').innerHTML = RAW.repos.map(r => `
    <div class="repo-card">
      <div class="repo-name">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px;margin-right:5px;opacity:.6"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/></svg>
        ${escHtml(r.name)}
      </div>
      ${r.description ? `<div class="repo-desc">${escHtml(r.description)}</div>` : ''}
      <div class="repo-meta">
        ${r.language ? `<span class="repo-lang">${escHtml(r.language)}</span>` : ''}
        <span class="repo-stat">★ ${r.stargazers_count || 0}</span>
        <span class="repo-stat">🍴 ${r.forks_count || 0}</span>
        ${r.open_issues_count ? `<span class="repo-stat">⚠ ${r.open_issues_count}</span>` : ''}
        <span class="repo-stat" title="Updated">${timeAgo(r.updated_at)}</span>
      </div>
    </div>`).join('');
}

// ── Wiring ───────────────────────────────────────────────────────────────────
$('configForm').addEventListener('submit', e => {
  e.preventDefault();
  const token = $('token').value.trim();
  const org = $('org').value.trim();
  const days = parseInt($('days').value, 10);
  if (!token) { showError('Please enter a GitHub personal access token.'); return; }
  if (!org) { showError('Please enter an organization or user name.'); return; }
  try { localStorage.setItem('gh_metrics_token', token); } catch (_) {}
  clearError();
  loadMetrics(token, org, days);
});

try {
  const saved = localStorage.getItem('gh_metrics_token');
  if (saved && !$('token').value) $('token').value = saved;
} catch (_) {}

document.querySelectorAll('.nav-link').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); if (DATA) setActiveView(el.dataset.view); });
});
document.querySelectorAll('.gran-btn').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); setGranularity(el.dataset.gran); });
});
