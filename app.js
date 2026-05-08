'use strict';

let charts = [];
let cancelled = false;
let lastParams = null;

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).style.display = '';
const hide = id => $(id).style.display = 'none';

function setProgress(label, pct) {
  $('progressLabel').textContent = label;
  $('progressBar').style.width = Math.min(100, pct) + '%';
}

function showError(msg) {
  $('errorBanner').style.display = 'block';
  $('errorBanner').innerHTML = '⚠️ ' + msg;
}

function clearError() {
  hide('errorBanner');
  $('errorBanner').innerHTML = '';
}

function toggleToken() {
  const inp = $('token');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function cancelLoad() {
  cancelled = true;
}

function reload() {
  if (lastParams) loadMetrics(lastParams.token, lastParams.org, lastParams.days);
}

// ── GitHub API ───────────────────────────────────────────────────────────────
async function ghFetch(path, token) {
  if (cancelled) throw new Error('Cancelled');
  const r = await fetch('https://api.github.com' + path, {
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json'
    }
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

async function getContribStats(org, repoName, token, cutoffTs) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (cancelled) return [];
    const r = await fetch('https://api.github.com/repos/' + org + '/' + repoName + '/stats/contributors', {
      headers: { 'Authorization': 'token ' + token }
    });
    if (r.status === 202) {
      await sleep(2500);
      continue;
    }
    if (r.status !== 200) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data;
  }
  return [];
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Main loader ──────────────────────────────────────────────────────────────
async function loadMetrics(token, org, days) {
  cancelled = false;
  lastParams = { token, org, days };
  clearError();

  // UI state: loading
  hide('dashboard');
  hide('emptyState');
  show('progress');
  hide('sidebarStats');
  $('loadBtn').disabled = true;
  setProgress('Connecting to GitHub…', 5);

  const SINCE = new Date(Date.now() - days * 864e5).toISOString();
  const cutoffTs = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    // Verify token
    const me = await ghFetch('/user', token);
    setProgress('Authenticated as ' + me.login, 10);

    // Load repos
    setProgress('Loading repositories…', 15);
    let repos = [];
    try {
      repos = await getAllPages('/orgs/' + org + '/repos', token);
    } catch (e) {
      try {
        repos = await getAllPages('/users/' + org + '/repos', token);
      } catch (e2) {
        throw new Error('Cannot find org or user "' + org + '". ' + e.message);
      }
    }

    if (!repos.length) throw new Error('No repositories found in ' + org);

    // Sort by most recently updated
    repos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    const CM = {};   // contributor map
    const WM = {};   // weekly/monthly commit map
    let totA = 0, totD = 0, totC = 0;

    const total = repos.length;

    for (let i = 0; i < repos.length; i++) {
      if (cancelled) throw new Error('Cancelled');
      const repo = repos[i];
      const pct = 15 + ((i / total) * 70);

      // Commits
      setProgress('Commits (' + (i + 1) + '/' + total + '): ' + repo.name, pct);
      try {
        const commits = await getAllPages(
          '/repos/' + org + '/' + repo.name + '/commits?since=' + SINCE,
          token
        );
        totC += commits.length;
        for (const c of commits) {
          const login = (c.author && c.author.login) ||
                        (c.commit && c.commit.author && c.commit.author.name) ||
                        'unknown';
          const avatar = (c.author && c.author.avatar_url) || '';
          const dateStr = (c.commit && c.commit.author && c.commit.author.date) || '';

          if (!CM[login]) CM[login] = { login, avatar, commits: 0, additions: 0, deletions: 0, repos: [] };
          CM[login].commits++;
          if (avatar && !CM[login].avatar) CM[login].avatar = avatar;
          if (!CM[login].repos.includes(repo.name)) CM[login].repos.push(repo.name);

          if (dateStr) {
            const k = dateStr.slice(0, 7); // YYYY-MM
            WM[k] = (WM[k] || 0) + 1;
          }
        }
      } catch (e) { /* skip repo if forbidden */ }

      // Contributor stats (additions/deletions)
      setProgress('Stats (' + (i + 1) + '/' + total + '): ' + repo.name, pct + 0.5);
      try {
        const stats = await getContribStats(org, repo.name, token, cutoffTs);
        for (const s of stats) {
          const login = s.author && s.author.login;
          if (!login) continue;
          if (!CM[login]) CM[login] = { login, avatar: s.author.avatar_url || '', commits: 0, additions: 0, deletions: 0, repos: [] };
          for (const w of (s.weeks || [])) {
            if (w.w >= cutoffTs) {
              CM[login].additions += (w.a || 0);
              CM[login].deletions += (w.d || 0);
              totA += (w.a || 0);
              totD += (w.d || 0);
            }
          }
        }
      } catch (e) { /* skip */ }
    }

    setProgress('Rendering…', 90);

    const contributors = Object.values(CM)
      .sort((a, b) => (b.additions + b.deletions + b.commits * 10) - (a.additions + a.deletions + a.commits * 10));

    const weekly = Object.entries(WM)
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([w, c]) => ({ w, c }));

    renderDashboard({ repos, contributors, weekly, totA, totD, totC, days, org });

  } catch (e) {
    hide('progress');
    $('loadBtn').disabled = false;
    if (e.message !== 'Cancelled') {
      showError(e.message);
      show('emptyState');
    }
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderDashboard({ repos, contributors, weekly, totA, totD, totC, days, org }) {
  hide('progress');
  hide('emptyState');
  $('loadBtn').disabled = false;

  // Destroy old charts
  charts.forEach(c => c.destroy());
  charts = [];

  const net = totA - totD;

  // Header
  $('dashTitle').textContent = org;
  $('dashSubtitle').textContent =
    'Last ' + days + ' days  ·  ' + repos.length + ' repos  ·  ' + contributors.length + ' contributors';

  // Metric cards
  const metricsData = [
    { label: 'Total Commits',   value: totC.toLocaleString(),                         icon: '📝' },
    { label: 'Lines Added',     value: '+' + totA.toLocaleString(),                   icon: '🟢', cls: 'green' },
    { label: 'Lines Removed',   value: '−' + totD.toLocaleString(),                   icon: '🔴', cls: 'red' },
    { label: 'Net Change',      value: (net >= 0 ? '+' : '') + net.toLocaleString(),  icon: '📊', cls: net >= 0 ? 'green' : 'red' },
    { label: 'Repositories',   value: repos.length,                                   icon: '📁' },
    { label: 'Contributors',   value: contributors.length,                             icon: '👥' },
  ];

  $('metricGrid').innerHTML = metricsData.map(m => `
    <div class="metric-card">
      <div class="m-icon">${m.icon}</div>
      <div class="m-label">${m.label}</div>
      <div class="m-value${m.cls ? ' ' + m.cls : ''}">${m.value}</div>
    </div>
  `).join('');

  // Sidebar stats
  $('sidebarStats').innerHTML = metricsData.map(m => `
    <div class="stat-row">
      <span class="stat-label">${m.label}</span>
      <span class="stat-val">${m.value}</span>
    </div>
  `).join('');
  show('sidebarStats');

  // Activity chart
  if (weekly.length) {
    const actCtx = $('activityChart').getContext('2d');
    charts.push(new Chart(actCtx, {
      type: 'line',
      data: {
        labels: weekly.map(x => x.w),
        datasets: [{
          label: 'Commits',
          data: weekly.map(x => x.c),
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88,166,255,0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: '#58a6ff',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          x: {
            ticks: { color: '#6e7681', font: { size: 11 }, maxRotation: 45 },
            grid: { color: '#21262d' }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#6e7681', font: { size: 11 } },
            grid: { color: '#21262d' }
          }
        }
      }
    }));
  }

  // Contributor bar chart
  if (contributors.length) {
    const top = contributors.slice(0, 15);
    const h = Math.max(260, top.length * 44 + 80);
    $('contribChartWrap').style.height = h + 'px';

    const ccCtx = $('contribChart').getContext('2d');
    charts.push(new Chart(ccCtx, {
      type: 'bar',
      data: {
        labels: top.map(c => c.login),
        datasets: [
          {
            label: 'Additions',
            data: top.map(c => c.additions),
            backgroundColor: 'rgba(63,185,80,0.8)',
            borderRadius: 4
          },
          {
            label: 'Deletions',
            data: top.map(c => c.deletions),
            backgroundColor: 'rgba(248,81,73,0.8)',
            borderRadius: 4
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: '#8b949e', font: { size: 12 }, boxWidth: 12, boxHeight: 12 }
          },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          x: {
            ticks: { color: '#6e7681', font: { size: 11 } },
            grid: { color: '#21262d' }
          },
          y: {
            ticks: { color: '#e6edf3', font: { size: 12 } },
            grid: { color: '#21262d' }
          }
        }
      }
    }));
  }

  // Contributor table
  $('contribBody').innerHTML = contributors.map((c, i) => {
    const net = c.additions - c.deletions;
    const initials = c.login.slice(0, 2).toUpperCase();
    return `
      <tr>
        <td>
          <div class="contributor-name">
            <div class="avatar">
              ${c.avatar ? `<img src="${c.avatar}" alt="${c.login}" loading="lazy" />` : initials}
            </div>
            ${c.login}
          </div>
        </td>
        <td class="num">${c.commits.toLocaleString()}</td>
        <td class="num green">+${c.additions.toLocaleString()}</td>
        <td class="num red">−${c.deletions.toLocaleString()}</td>
        <td class="num ${net >= 0 ? 'green' : 'red'}">${net >= 0 ? '+' : ''}${net.toLocaleString()}</td>
        <td class="muted">${c.repos.join(', ')}</td>
      </tr>
    `;
  }).join('');

  // Repo grid
  $('repoGrid').innerHTML = repos.map(r => `
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
    </div>
  `).join('');

  show('dashboard');
}

// ── Utilities ────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 864e5);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  if (days < 365) return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'yr ago';
}

// ── Form submit ──────────────────────────────────────────────────────────────
$('configForm').addEventListener('submit', e => {
  e.preventDefault();
  const token = $('token').value.trim();
  const org   = $('org').value.trim();
  const days  = parseInt($('days').value);

  if (!token) { showError('Please enter a GitHub personal access token.'); return; }
  if (!org)   { showError('Please enter an organization or user name.'); return; }

  clearError();
  loadMetrics(token, org, days);
});
