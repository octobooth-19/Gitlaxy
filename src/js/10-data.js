/* Gitlaxy — 10-data.js
 * GitHub REST access (browser fetch, unauthenticated by default), normalization, caching,
 * recent logins, and deterministic offline demo users (@mona, @hubot).
 */
(() => {
  'use strict';
  const GLX = window.GLX;
  const { util } = GLX;

  const API = 'https://api.github.com';
  const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
  const DAY = 864e5;

  class ApiError extends Error {
    constructor(code, message, status = 0, resetAt = null) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.resetAt = resetAt;
    }
  }

  const rateLimit = { remaining: null, limit: null, resetAt: null };

  function parseLogin(input) {
    let s = String(input == null ? '' : input).trim();
    const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@+/, '').trim();
    return LOGIN_RE.test(s) ? s : null;
  }

  const getToken = () => String(util.storage.session.get('token', '') || '');
  function setToken(token) {
    const t = String(token || '').trim();
    if (t) util.storage.session.set('token', t);
    else util.storage.session.del('token');
  }

  function fmtClock(ms) {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return 'soon';
    }
  }

  async function api(path, signal) {
    const headers = { Accept: 'application/vnd.github+json' };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(API + path, { headers, signal });
    } catch (e) {
      if ((e && e.name === 'AbortError') || (signal && signal.aborted)) throw new ApiError('aborted', 'Cancelled.');
      throw new ApiError('network', 'Couldn’t reach api.github.com — are you offline?');
    }
    const header = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
    const rem = header('x-ratelimit-remaining');
    const lim = header('x-ratelimit-limit');
    const reset = header('x-ratelimit-reset');
    if (rem != null) rateLimit.remaining = Number(rem);
    if (lim != null) rateLimit.limit = Number(lim);
    if (reset != null) rateLimit.resetAt = Number(reset) * 1000;
    if (res.ok) return res.json();
    if (res.status === 404) throw new ApiError('not_found', 'Not found.', 404);
    if (res.status === 401) throw new ApiError('bad_token', 'That GitHub token was rejected — update or clear it.', 401);
    if (res.status === 429 || (res.status === 403 && rem === '0')) {
      const at = reset != null ? Number(reset) * 1000 : null;
      throw new ApiError(
        'rate_limited',
        'GitHub’s API limit (' + (lim || 60) + ' requests/hour' + (token ? '' : ' without a token') + ') was reached. It resets at ' +
          (at ? fmtClock(at) : 'the top of the hour') + ' — add a token or explore a demo galaxy.',
        res.status,
        at
      );
    }
    throw new ApiError('http', 'GitHub API error ' + res.status + '.', res.status);
  }

  // ------------------------------------------------------------------ normalization
  const ms = (v) => {
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  };
  const trunc = (s, n = 60) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
  const refName = (ref) => String(ref || '').replace(/^refs\/(heads|tags)\//, '');

  function normalizeProfile(p) {
    return {
      login: String(p.login),
      name: p.name || String(p.login),
      avatarUrl: p.avatar_url || null,
      bio: p.bio || '',
      url: p.html_url || 'https://github.com/' + p.login,
      createdAt: ms(p.created_at),
      publicRepos: Number(p.public_repos) || 0,
      followers: Number(p.followers) || 0,
      following: Number(p.following) || 0,
      type: p.type === 'Organization' ? 'Organization' : 'User',
      id: p.id != null ? p.id : null,
      isDemo: false
    };
  }

  function normalizeRepo(r) {
    const lic = r.license
      ? r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : r.license.name || null
      : null;
    return {
      name: String(r.name),
      fullName: r.full_name || String(r.name),
      description: r.description || '',
      language: r.language || null,
      stars: Number(r.stargazers_count) || 0,
      forks: Number(r.forks_count) || 0,
      issues: Number(r.open_issues_count) || 0,
      createdAt: ms(r.created_at),
      pushedAt: ms(r.pushed_at || r.updated_at),
      url: r.html_url || '',
      homepage: r.homepage || '',
      topics: Array.isArray(r.topics) ? r.topics.slice(0, 12) : [],
      license: lic,
      isFork: !!r.fork,
      isArchived: !!r.archived,
      size: Number(r.size) || 0
    };
  }

  function normalizeEvent(e) {
    const p = e.payload || {};
    const repo = (e.repo && e.repo.name) || '';
    let kind = 'other', icon = '•', label;
    switch (e.type) {
      case 'PushEvent': {
        kind = 'push'; icon = '⬆️';
        const n = Number(p.distinct_size != null ? p.distinct_size : p.size);
        const br = refName(p.ref) || 'main';
        label = n > 0 ? 'Pushed ' + n + ' commit' + (n === 1 ? '' : 's') + ' to ' + trunc(br, 24) : 'Pushed to ' + trunc(br, 24);
        break;
      }
      case 'PullRequestEvent': {
        kind = 'pr'; icon = '🔀';
        const pr = p.pull_request || {};
        const act = p.action === 'closed' ? (pr.merged ? 'Merged' : 'Closed') : cap(p.action || 'updated');
        label = act + ' PR' + (pr.title ? ': ' + trunc(pr.title, 48) : p.number ? ' #' + p.number : '');
        break;
      }
      case 'IssuesEvent': {
        kind = 'issue'; icon = '🐛';
        const is = p.issue || {};
        label = cap(p.action || 'updated') + ' issue' + (is.title ? ': ' + trunc(is.title, 48) : '');
        break;
      }
      case 'IssueCommentEvent': {
        kind = 'comment'; icon = '💬';
        const is = p.issue || {};
        label = 'Commented on ' + (is.number ? '#' + is.number : 'an issue') + (is.title ? ': ' + trunc(is.title, 40) : '');
        break;
      }
      case 'WatchEvent': kind = 'star'; icon = '⭐'; label = 'Starred'; break;
      case 'CreateEvent':
        kind = 'create'; icon = '✨';
        label = p.ref_type === 'repository' ? 'Created repository' : p.ref_type === 'tag' ? 'Tagged ' + trunc(refName(p.ref), 30) : 'Created branch ' + trunc(refName(p.ref), 30);
        break;
      case 'ForkEvent': kind = 'fork'; icon = '🍴'; label = 'Forked'; break;
      case 'ReleaseEvent':
        kind = 'release'; icon = '🚀';
        label = 'Released ' + trunc((p.release && (p.release.tag_name || p.release.name)) || 'a new version', 30);
        break;
      case 'PullRequestReviewEvent':
        kind = 'review'; icon = '👀';
        label = 'Reviewed PR' + (p.pull_request && p.pull_request.title ? ': ' + trunc(p.pull_request.title, 44) : '');
        break;
      case 'PullRequestReviewCommentEvent': kind = 'review'; icon = '👀'; label = 'Commented on a PR review'; break;
      case 'DeleteEvent': icon = '🧹'; label = 'Deleted ' + (p.ref_type || 'branch') + ' ' + trunc(refName(p.ref), 30); break;
      case 'PublicEvent': kind = 'create'; icon = '📣'; label = 'Open-sourced'; break;
      case 'MemberEvent': icon = '🤝'; label = 'Added a collaborator'; break;
      case 'GollumEvent': icon = '📖'; label = 'Updated the wiki'; break;
      case 'CommitCommentEvent': kind = 'comment'; icon = '💬'; label = 'Commented on a commit'; break;
      default: label = trunc(String(e.type || 'Activity').replace(/Event$/, ''), 40);
    }
    return { type: String(e.type || 'Event'), kind, repo, createdAt: ms(e.created_at), label, icon };
  }

  // ------------------------------------------------------------------ loading
  async function loadUser(login, opts = {}) {
    const name = parseLogin(login);
    if (!name) throw new ApiError('invalid_login', 'That doesn’t look like a GitHub username.');
    const key = 'cache:' + name.toLowerCase();
    const cached = util.storage.get(key);
    if (cached && cached.profile && Array.isArray(cached.repos) && Date.now() - (cached.fetchedAt || 0) < GLX.config.CACHE_TTL_MS) {
      return Object.assign({}, cached, { source: 'cache' });
    }
    const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const signal = opts.signal;
    progress('Contacting api.github.com…');
    let raw;
    try {
      raw = await api('/users/' + encodeURIComponent(name), signal);
    } catch (e) {
      if (e.code === 'not_found') e.message = 'No GitHub user or org named @' + name + '.';
      throw e;
    }
    const profile = normalizeProfile(raw);
    const maxPages = Math.max(1, opts.maxPages || 3);
    const pages = profile.publicRepos > 0 ? Math.min(maxPages, Math.ceil(profile.publicRepos / 100)) : 0;
    progress(profile.publicRepos ? 'Found ' + util.fmtNum(profile.publicRepos) + ' repositories…' : 'No public repositories yet…');
    const base = '/users/' + encodeURIComponent(profile.login);
    const pageData = await Promise.all(
      Array.from({ length: pages }, (_, i) => api(base + '/repos?per_page=100&sort=pushed&type=owner&page=' + (i + 1), signal))
    );
    const seen = new Set();
    const repos = [];
    for (const page of pageData) {
      for (const r of Array.isArray(page) ? page : []) {
        const id = r && (r.id != null ? r.id : r.full_name);
        if (!r || seen.has(id)) continue;
        seen.add(id);
        repos.push(normalizeRepo(r));
      }
    }
    progress('Reading recent activity…');
    let events = [];
    try {
      const ev = await api(base + '/events/public?per_page=100', signal);
      events = (Array.isArray(ev) ? ev : [])
        .map(normalizeEvent)
        .filter((e) => e.repo && e.createdAt)
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      if (e.code === 'aborted') throw e;
      events = [];
    }
    const data = { profile, repos, events, source: 'api', truncated: profile.publicRepos > repos.length, fetchedAt: Date.now() };
    util.storage.set(key, data);
    return data;
  }

  const recent = {
    list() {
      const l = util.storage.get('recent', []);
      return Array.isArray(l) ? l.filter((x) => typeof x === 'string' && LOGIN_RE.test(x)).slice(0, 6) : [];
    },
    add(login) {
      if (!login || !LOGIN_RE.test(login)) return;
      const l = recent.list().filter((x) => x.toLowerCase() !== String(login).toLowerCase());
      l.unshift(String(login));
      util.storage.set('recent', l.slice(0, 6));
    }
  };

  // ------------------------------------------------------------------ demo users (synthetic, deterministic)
  const DEMO = {
    mona: {
      owner: 'mona',
      name: 'Mona Lisa Octocat (demo)',
      bio: 'Eight arms, infinite side projects. Painting the universe one commit at a time.',
      years: 12, count: 110, followers: 8192, following: 8,
      langs: [['JavaScript', 26], ['TypeScript', 22], ['Ruby', 12], ['Go', 10], ['Python', 9], ['Rust', 7], ['CSS', 6], ['Shell', 5], [null, 3]],
      iconic: [
        ['hello-world', 'Ruby', 'My very first repository — still shining after all these years.', 2100, 0.01],
        ['spoon-knife', 'JavaScript', 'The fork you fork to learn forking.', 5400, 0.08],
        ['tentacle-ui', 'TypeScript', 'A component library with exactly eight variants of everything.', 1300, 0.55],
        ['octicons-lab', 'TypeScript', 'Experimental icons, drawn with eight very steady hands.', 860, 0.7],
        ['linguist-lite', 'Ruby', 'Detects languages in 2 KB. Mostly accurate. Always confident.', 420, 0.3],
        ['ink-blot', 'Go', 'Generates Rorschach art from your commit graph.', 230, 0.82],
        ['dotfiles', 'Shell', 'Zsh, Neovim and an unreasonable number of aliases.', 64, 0.2],
        ['advent-of-code', 'Python', '25 days, 50 stars, 0 sleep.', 38, 0.9],
        ['blog', 'TypeScript', 'Notes from the deep end of the ocean (and the stack).', 21, 0.45]
      ],
      prefixes: ['octo', 'ink', 'tide', 'reef', 'kelp', 'coral', 'sonar', 'pearl', 'squid', 'nautilus', 'abyss', 'lagoon', 'harbor', 'drift', 'bubble', 'pixel', 'merge', 'commit', 'nebula', 'comet'],
      suffixes: ['kit', 'cli', 'lab', 'api', 'ui', 'bot', 'engine', 'notes', 'sandbox', 'sdk', 'tools', 'action', 'server', 'graph', 'lint', 'viz', 'store', 'sync', 'deck', 'forge'],
      external: ['octo-org/warp-drive', 'octo-org/linguist-next', 'stellar-labs/nebula-db', 'tidepool/reef-ui', 'quantum-quokka/lint-o-matic']
    },
    hubot: {
      owner: 'hubot',
      name: 'Hubot (demo)',
      bio: 'ChatOps robot. I deploy, I pug-bomb, I never sleep.',
      years: 14, count: 70, followers: 4096, following: 1,
      langs: [['CoffeeScript', 30], ['JavaScript', 18], ['Python', 12], ['Shell', 12], ['Go', 8], ['Rust', 6], ['Ruby', 6], [null, 3]],
      iconic: [
        ['hello-world', 'CoffeeScript', 'beep boop. hello, world.', 77, 0.01],
        ['hubot-scripts', 'CoffeeScript', 'The legendary script collection: pug me, ship it, deploy all the things.', 3100, 0.12],
        ['chatops-deploy', 'CoffeeScript', 'Deploy from chat in style. /deploy everything --yolo (disabled).', 940, 0.35],
        ['pugme', 'CoffeeScript', 'Responds with a random pug. Mission-critical infrastructure.', 610, 0.2],
        ['redis-brain', 'JavaScript', 'Long-term memory for robots who forget things.', 380, 0.5],
        ['shipit', 'Ruby', 'Ship-it squirrel, as a service.', 270, 0.4],
        ['dotfiles', 'Shell', 'Robots need aliases too.', 45, 0.3],
        ['advent-of-code', 'Rust', 'Solving puzzles at 300 operations per second.', 52, 0.92],
        ['blog', 'JavaScript', 'Dispatches from the chat room.', 18, 0.6]
      ],
      prefixes: ['chat', 'deploy', 'robot', 'beep', 'boop', 'bolt', 'servo', 'gear', 'pager', 'alert', 'ping', 'webhook', 'cron', 'relay', 'socket', 'ops', 'pug', 'karma', 'brain', 'shipit'],
      suffixes: ['adapter', 'script', 'bot', 'relay', 'hooks', 'brain', 'cli', 'daemon', 'bridge', 'watch', 'runner', 'queue', 'monitor', 'proxy', 'agent', 'kit', 'core', 'api', 'tools', 'lab'],
      external: ['octo-org/warp-drive', 'chatops-guild/standup-bot', 'cloud-kitchen/ovenctl', 'octo-org/linguist-next', 'pixel-pals/sprite-forge']
    }
  };
  const ADJ = ['Blazing-fast', 'Delightfully tiny', 'Over-engineered', 'Weekend', 'Zero-config', 'Experimental', 'Opinionated', 'Cozy', 'Fearless', 'Pocket-sized'];
  const THING = ['toolkit', 'CLI', 'library', 'playground', 'service', 'plugin', 'visualizer', 'bot', 'prototype', 'starter'];
  const PURPOSE = ['taming YAML', 'counting stars', 'herding cats', 'parsing the cosmos', 'faster builds', 'late-night ideas', 'turning coffee into code',
    'mapping the ocean floor', 'debugging in the dark', 'shipping on Fridays', 'naming things', 'cache invalidation'];
  const TOPICS = ['cli', 'visualization', 'webgl', 'devtools', 'automation', 'github-actions', 'api', 'game', 'productivity', 'open-source', 'hacktoberfest', 'chatops'];
  const LICENSES = ['MIT', 'MIT', 'MIT', 'Apache-2.0', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'MPL-2.0'];
  const TITLES = ['Fix the flux capacitor', 'Add dark mode to the void', 'Speed up star rendering', 'Refactor tentacle handling', 'Bump dependencies',
    'Docs: explain the universe', 'Handle empty galaxies', 'Make the robot friendlier', 'Teach the parser emoji', 'Reduce warp-drive jitter'];

  function makeDesc(R, lang) {
    const r = R();
    if (r < 0.5) return (util.pick(R, ADJ) + ' ' + (lang ? lang + ' ' : '') + util.pick(R, THING) + ' for ' + util.pick(R, PURPOSE) + '.');
    if (r < 0.85) return 'A ' + util.pick(R, THING) + ' for ' + util.pick(R, PURPOSE) + '.';
    return '';
  }

  function demoUser(id) {
    const key = id === 'hubot' ? 'hubot' : 'mona';
    const d = DEMO[key];
    const R = util.rng(util.hashStr('demo:' + key));
    const now = Date.now();
    const created = now - d.years * 365.25 * DAY - 40 * DAY;
    const span = now - created - 25 * DAY;
    const used = new Set();
    const repos = [];
    const langW = d.langs.map((l) => l[1]);

    const make = (name, lang, desc, stars, u, isFork) => {
      used.add(name);
      const createdAt = created + 20 * DAY + u * span;
      const pushedAt = R() < 0.27 ? now - R() * 28 * DAY : createdAt + Math.pow(R(), 0.6) * (now - createdAt);
      const topics = R() < 0.4 ? [...new Set([lang ? lang.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'misc', util.pick(R, TOPICS), util.pick(R, TOPICS)])] : [];
      return {
        name,
        fullName: d.owner + '/' + name,
        description: desc,
        language: lang,
        stars,
        forks: isFork ? 0 : Math.round(stars * (0.04 + R() * 0.12) + (R() < 0.3 ? R() * 3 : 0)),
        issues: R() < 0.5 ? Math.round(R() * Math.min(40, 2 + stars / 40)) : 0,
        createdAt,
        pushedAt: Math.min(now, pushedAt),
        url: 'https://github.com/' + d.owner + '/' + name,
        homepage: !isFork && R() < 0.08 ? 'https://' + d.owner + '.github.io/' + name : '',
        topics,
        license: R() < 0.6 ? util.pick(R, LICENSES) : null,
        isFork,
        isArchived: !isFork && u < 0.7 && R() < 0.05,
        size: Math.round(50 + R() * 40000)
      };
    };

    for (const [name, lang, desc, stars, u] of d.iconic) repos.push(make(name, lang, desc, stars, u, false));
    while (repos.length < d.count) {
      const fork = R() < 0.12;
      let name = '';
      for (let tries = 0; tries < 60; tries++) {
        name = util.pick(R, d.prefixes) + '-' + util.pick(R, d.suffixes);
        if (R() < 0.12) name += '-' + (2 + Math.floor(R() * 4));
        if (!used.has(name)) break;
      }
      if (used.has(name)) name += '-' + repos.length;
      const lang = d.langs[util.weightedIndex(R, langW)][0];
      const stars = fork ? (R() < 0.8 ? 0 : 1) : Math.max(0, Math.floor(Math.exp(util.gauss(R) * 1.35 + 1.1)) - 1);
      const desc = fork ? 'Fork of ' + util.pick(R, d.external).split('/')[0] + '/' + name + ' — exploring other worlds.' : makeDesc(R, lang);
      repos.push(make(name, lang, desc, stars, Math.pow(R(), 0.62), fork));
    }

    const own = repos.filter((r) => !r.isFork);
    const active = own.filter((r) => now - r.pushedAt < 30 * DAY);
    const pool = active.length ? active : own;
    const raw = [];
    const N = 50 + Math.floor(R() * 25);
    for (let i = 0; i < N; i++) {
      const ext = R() < 0.25;
      const repo = ext ? util.pick(R, d.external) : d.owner + '/' + util.pick(R, pool).name;
      const createdAt = now - Math.pow(R(), 1.3) * 60 * DAY;
      const roll = R();
      let type, payload;
      if (!ext && roll < 0.55) {
        type = 'PushEvent';
        payload = { size: 1 + Math.floor(R() * 6), ref: 'refs/heads/' + (R() < 0.8 ? 'main' : util.pick(R, ['dev', 'feat/stars', 'fix/orbit'])) };
      } else if (roll < 0.7) {
        const merged = R() < 0.5;
        type = 'PullRequestEvent';
        payload = { action: merged ? 'closed' : 'opened', pull_request: { title: util.pick(R, TITLES), merged } };
      } else if (roll < 0.8) {
        type = 'IssuesEvent';
        payload = { action: R() < 0.6 ? 'opened' : 'closed', issue: { title: util.pick(R, TITLES) } };
      } else if (roll < 0.86) {
        type = 'IssueCommentEvent';
        payload = { action: 'created', issue: { number: 1 + Math.floor(R() * 400), title: util.pick(R, TITLES) } };
      } else if (roll < 0.9) {
        type = 'WatchEvent'; payload = { action: 'started' };
      } else if (roll < 0.94) {
        type = 'ReleaseEvent'; payload = { release: { tag_name: 'v' + (1 + Math.floor(R() * 3)) + '.' + Math.floor(R() * 10) + '.0' } };
      } else if (roll < 0.97) {
        type = 'PullRequestReviewEvent'; payload = { pull_request: { title: util.pick(R, TITLES) } };
      } else if (roll < 0.99) {
        type = 'CreateEvent'; payload = { ref_type: 'branch', ref: 'feat/comets' };
      } else {
        type = 'ForkEvent'; payload = {};
      }
      raw.push({ type, repo: { name: repo }, created_at: new Date(createdAt).toISOString(), payload });
    }
    const events = raw.map(normalizeEvent).sort((a, b) => b.createdAt - a.createdAt);

    const profile = {
      login: d.owner, name: d.name, avatarUrl: null, bio: d.bio, url: 'https://github.com/' + d.owner,
      createdAt: created, publicRepos: repos.length, followers: d.followers, following: d.following,
      type: 'User', id: null, isDemo: true
    };
    return { profile, repos, events, source: 'demo', truncated: false, fetchedAt: now };
  }

  GLX.Data = {
    parseLogin, loadUser, demoUser, getToken, setToken, recent, rateLimit, ApiError,
    normalizeProfile, normalizeRepo, normalizeEvent
  };
})();
