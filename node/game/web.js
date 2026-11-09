// Website: account registration (#19) and clan management, plain HTML forms with no client JS so it also works in the
// game's embedded Internet Explorer (client chat command `/url`). Runs inside the game server so clan actions share
// its in-memory state with the in-game clan packets. Put it behind an HTTPS reverse proxy when it faces the internet.
const http = require('http');
const crypto = require('crypto');
const { hashPassword, newScryptSalt, sameHash } = require('../auth/handlers');
const clan = require('./clan');
const { loadUserDetails } = require('./progression');
const { webTokenUser } = require('./internal-client');
const emblems = require('./emblems');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY = 4096;
const USERNAME_RE = /^[A-Za-z0-9]{3,20}$/; // users.username varchar(20); the login accepts only alphanumerics
const NICKNAME_RE = /^[A-Za-z0-9]{3,16}$/; // same rule as the in-game rename (shop.js)
// The client caches each emblem file by name for the whole session: a change shows after restarting the game.
const EMBLEM_CHANGED = 'Emblem changed. In game it shows after you restart the game.';
const RANK_NAME = { 0: 'Member', 1: 'Officer', 2: 'Master', 9: 'Applicant' };

const sessions = new Map(); // token -> { userId, username, displayname, csrf, expires }
const attempts = new Map(); // `${kind}:${ip}` -> timestamps, for the login and registration limits

function tooMany(kind, ip, max, windowMs) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  attempts.set(key, list);
  return list.length >= max;
}

function note(kind, ip) {
  attempts.get(`${kind}:${ip}`).push(Date.now());
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body, s) {
  const nav = s
    ? `<a href="/clan">Clan</a> <a href="/clans">Clans</a> <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${s.csrf}"><button>Logout ${esc(s.displayname)}</button></form>`
    : '<a href="/clans">Clans</a> <a href="/register">Register</a> <a href="/login">Login</a>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - WarRock</title><style>${CSS}</style></head>
<body><div class="scan"></div><div class="wrap"><div class="top"><a href="/" class="logo">WAR<b>ROCK</b></a><span class="nav">${nav}</span></div>
<div class="ruler"></div><h1>${esc(title)}</h1>${body}</div></body></html>`;
}

const CSS = `body{margin:0;background:#151617;color:#ECECEC;font:14px Tahoma,Verdana,sans-serif}
.wrap{position:relative;max-width:720px;margin:0 auto;padding:12px 16px}
.scan{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;background:repeating-linear-gradient(to bottom,rgba(255,255,255,.025) 0,rgba(255,255,255,.025) 1px,transparent 1px,transparent 4px);animation:down 8s linear infinite}
.ruler{height:8px;margin:6px 0 4px;background:repeating-linear-gradient(to right,#55585A 0,#55585A 1px,transparent 1px,transparent 10px);animation:down 2s linear infinite}
@keyframes down{from{background-position:0 0}to{background-position:0 40px}}
.top{overflow:hidden;border-bottom:1px solid #55585A;padding-bottom:8px}.logo{float:left;font:bold 22px Arial,sans-serif;letter-spacing:2px;color:#E4E4E4;text-decoration:none}.logo b{color:#F2B01E}
.nav{float:right;line-height:28px}.nav a{margin-left:12px}
a{color:#F2B01E}h1{font:bold 16px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:#C9CBCC}
.box{background:#262728;border:1px solid #55585A;padding:12px;margin:0 0 12px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #303132}th{color:#A3A6A8;font-weight:normal;text-transform:uppercase;font-size:12px}
input{background:#151617;color:#ECECEC;border:1px solid #55585A;padding:5px;width:220px}label{display:block;color:#A3A6A8;margin:8px 0 3px}
button{background:#303132;color:#ECECEC;border:1px solid #55585A;padding:5px 12px;cursor:pointer}button:hover{border-color:#F2B01E}
.inline{display:inline;margin:0}.inline button{padding:2px 8px;margin-left:4px}.danger{border-color:#E5533D}
.err{color:#E5533D}.ok{color:#E8912D}.muted{color:#A3A6A8}
.emblem{width:32px;height:32px;vertical-align:middle;-ms-interpolation-mode:nearest-neighbor;image-rendering:pixelated;border:1px solid #55585A}
.big{width:48px;height:48px}.gallery label{display:inline-block;margin:4px 6px 4px 0;color:#ECECEC}.gallery input{width:auto}`;

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', ...headers });
  res.end(html);
}

const redirect = (res, to, headers = {}) => {
  res.writeHead(303, { Location: to, ...headers });
  res.end();
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

function session(req) {
  const m = /(?:^|;\s*)wr_s=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s || s.expires < Date.now()) return null;
  s.expires = Date.now() + SESSION_TTL_MS;
  return s;
}

const form = (action, fields, button, csrf) =>
  `<form method="post" action="${action}">${csrf ? `<input type="hidden" name="csrf" value="${csrf}">` : ''}${fields}<p><button>${button}</button></p></form>`;

const field = (name, label, type = 'text') => `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}">`;

const msg = (text, cls = 'err') => (text ? `<p class="${cls}">${esc(text)}</p>` : '');

// One-button form posting a clan action; `extra` carries the target/clan id.
const act = (s, action, label, extra = '', cls = '') =>
  `<form method="post" action="/clan" class="inline"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="action" value="${action}">${extra}<button class="${cls}">${label}</button></form>`;

function registerPage(res, error) {
  send(res, error ? 400 : 200, page('Register', `<div class="box">${msg(error)}${form('/register',
    field('username', 'Username (login, 3-20 letters or digits)') + field('nickname', 'Nickname (in game, 3-16 letters or digits)') +
    field('password', 'Password (6-16 characters)', 'password') + field('password2', 'Repeat password', 'password'), 'Create account')}</div>`));
}

async function register(req, res, authDb, ip) {
  const b = await readBody(req);
  const [username, nickname, password] = [b.get('username') || '', b.get('nickname') || '', b.get('password') || ''];
  if (!USERNAME_RE.test(username)) return registerPage(res, 'Invalid username.');
  if (!NICKNAME_RE.test(nickname)) return registerPage(res, 'Invalid nickname.');
  // 16: what the client's login field takes; a longer password could never be typed in game.
  if (password.length < 6 || password.length > 16) return registerPage(res, 'The password must be 6-16 characters.');
  if (password !== b.get('password2')) return registerPage(res, 'The passwords do not match.');
  if (tooMany('register', ip, 3, 60 * 60 * 1000)) return registerPage(res, 'Too many accounts from this address, try later.');

  const [taken] = await authDb.query('SELECT username FROM users WHERE username = ? OR displayname = ?', [username, nickname]);
  if (taken.length) return registerPage(res, 'Username or nickname already taken.');

  const salt = newScryptSalt();
  const hash = await hashPassword(password, salt);
  // users.id has no AUTO_INCREMENT upstream; the primary key and sql/09's unique names reject a concurrent duplicate.
  try {
    await authDb.query(
      'INSERT INTO users (id, username, status, displayname, password, passwordsalt) SELECT COALESCE(MAX(id), 0) + 1, ?, 1, ?, ?, ? FROM users',
      [username, nickname, hash, salt]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return registerPage(res, 'Username or nickname already taken, try again.');
    throw err;
  }
  note('register', ip);
  send(res, 200, page('Register', `<div class="box"><p class="ok">Account created. Log in from the game, or <a href="/login">here</a> to manage your clan.</p></div>`));
}

function loginPage(res, error) {
  send(res, error ? 400 : 200, page('Login', `<div class="box">${msg(error)}${form('/login', field('username', 'Username') + field('password', 'Password', 'password'), 'Login')}</div>`));
}

async function login(req, res, authDb, ip) {
  const b = await readBody(req);
  if (tooMany('login', ip, 5, 5 * 60 * 1000)) return loginPage(res, 'Too many attempts, wait a few minutes.');
  const [rows] = await authDb.query('SELECT id, status, displayname, password, passwordsalt FROM users WHERE username = ?', [b.get('username') || '']);
  const user = rows[0];
  if (!user || !sameHash(await hashPassword(b.get('password') || '', user.passwordsalt), user.password)) {
    note('login', ip);
    return loginPage(res, 'Wrong username or password.');
  }
  if (user.status <= 0) return loginPage(res, 'This account is banned.');
  signIn(res, Number(user.id), b.get('username'), user.displayname);
}

function signIn(res, userId, username, displayname) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, username, displayname, csrf: crypto.randomBytes(16).toString('hex'), expires: Date.now() + SESSION_TTL_MS });
  redirect(res, '/clan', { 'Set-Cookie': `wr_s=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
}

// Same order and points as the in-game clan ranking (clanExp: win 1000, draw 500, loss 250).
async function clansPage(res, s) {
  const list = [...clan.clans.values()].sort((a, b) => clan.clanExp(b) - clan.clanExp(a) || a.name.localeCompare(b.name));
  const names = await clan.resolveDisplaynames(list.map((c) => c.master));
  const rows = list
    .map((c, i) => `<tr><td>${i + 1}</td><td>${emblemImg(c)} ${esc(c.name)}</td><td>${esc(names.get(c.master) || '??')}</td><td>${c.members}/${clan.MAX_MEMBERS}</td><td>${c.wins}/${c.draws}/${c.losses}</td><td>${clan.clanExp(c)}</td></tr>`)
    .join('');
  send(res, 200, page('Clan ranking', `<div class="box"><table><tr><th>#</th><th>Clan</th><th>Master</th><th>Members</th><th>W/D/L</th><th>Points</th></tr>${rows || '<tr><td colspan="6" class="muted">No clans yet.</td></tr>'}</table>
<p class="muted">Clan wars: win 1000 points, draw 500, loss 250. A war counts when both clans have players at the start of the match.</p></div>`, s));
}

// Versioned by content so browsers (and the game's IE) refetch after a change.
function emblemImg(c, cls = 'emblem') {
  const v = crypto.createHash('md5').update(emblems.clanEmblem(c).data).digest('hex').slice(0, 8);
  return `<img class="${cls}" src="/avatar/${c.id}.jpg?v=${v}" alt="">`;
}

// A new account has no game row until its first game login; create it here so the site works right after sign-up.
async function player(db, s) {
  const u = (await clan.memberOf(db, s.userId)) || (await loadUserDetails(db, s.userId), await clan.memberOf(db, s.userId));
  u.displayname = u.displayname || s.displayname;
  return u;
}

async function clanPage(res, db, s, notice) {
  const u = await player(db, s);
  const c = clan.clans.get(u.clanId);
  let body = notice ? msg(notice.text, notice.ok ? 'ok' : 'err') : '';

  if (!c) {
    const list = [...clan.clans.values()].filter((x) => x.members < clan.MAX_MEMBERS);
    body += `<div class="box"><p>You are not in a clan. Dinars: ${u.money}</p>${form('/clan',
      '<input type="hidden" name="action" value="create">' + field('name', `Create a clan (5-20 letters, digits, _ or -), costs ${clan.CREATE_COST} dinars`), 'Create clan', s.csrf)}</div>`;
    body += `<div class="box"><table><tr><th>Clan</th><th>Members</th><th></th></tr>${list
      .map((x) => `<tr><td>${esc(x.name)}</td><td>${x.members}/${clan.MAX_MEMBERS}</td><td>${act(s, 'apply', 'Apply', `<input type="hidden" name="clan" value="${x.id}">`)}</td></tr>`)
      .join('') || '<tr><td colspan="3" class="muted">No clan is open.</td></tr>'}</table></div>`;
    return send(res, 200, page('Clan', body, s));
  }
  if (u.clanRank === clan.RANK.PENDING) {
    body += `<div class="box"><p>Application sent to <b>${esc(c.name)}</b>, waiting for a master or officer.</p>${act(s, 'leave', 'Withdraw')}</div>`;
    return send(res, 200, page('Clan', body, s));
  }

  const [rows] = await db.query('SELECT id, clanrank, xp FROM user_details WHERE clanid = ? ORDER BY clanrank DESC, xp DESC', [c.id]);
  const names = await clan.resolveDisplaynames(rows.map((r) => r.id));
  const boss = u.clanRank === clan.RANK.MASTER || u.clanRank === clan.RANK.OFFICER;
  const target = (id) => `<input type="hidden" name="target" value="${id}">`;
  const tr = (r, buttons) => `<tr><td>${esc(names.get(r.id) || '??')}</td><td>${RANK_NAME[r.clanrank]}</td><td>${r.xp}</td><td>${buttons}</td></tr>`;
  const members = rows.filter((r) => r.clanrank !== clan.RANK.PENDING);
  const pending = rows.filter((r) => r.clanrank === clan.RANK.PENDING);
  const isMaster = u.clanRank === clan.RANK.MASTER;
  // Officers may only kick plain members; everything else is the master's (clan.js rankAction).
  const memberButtons = (r) => {
    if (!boss || r.id === u.id || r.clanrank === clan.RANK.MASTER) return '';
    if (!isMaster) return r.clanrank === clan.RANK.MEMBER ? act(s, 'kick', 'Kick', target(r.id), 'danger') : '';
    return (r.clanrank === clan.RANK.MEMBER ? act(s, 'officer', 'Officer', target(r.id)) : act(s, 'demote', 'Demote', target(r.id))) +
      act(s, 'kick', 'Kick', target(r.id), 'danger') + act(s, 'master', 'Make master', target(r.id));
  };

  body += `<div class="box"><p>${emblemImg(c, 'emblem big')} <b>${esc(c.name)}</b> &middot; ${c.members}/${clan.MAX_MEMBERS} members &middot; W/D/L ${c.wins}/${c.draws}/${c.losses} &middot; ${clan.clanExp(c)} points &middot; you are ${RANK_NAME[u.clanRank]}</p>
<table><tr><th>Name</th><th>Rank</th><th>XP</th><th></th></tr>${members.map((r) => tr(r, memberButtons(r))).join('')}</table></div>`;
  if (boss) {
    body += `<div class="box"><h1>Applicants</h1>${pending.length
      ? `<table><tr><th>Name</th><th>Rank</th><th>XP</th><th></th></tr>${pending
        .map((r) => tr(r, act(s, 'accept', 'Accept', target(r.id)) + act(s, 'refuse', 'Refuse', target(r.id), 'danger')))
        .join('')}</table>`
      : `<p class="muted">No applications. Players apply from their own Clan page (or in game); they show up here to accept or refuse.${isMaster ? ' Members get buttons in the list above: Officer/Demote, Kick, Make master.' : ' Officers can kick members; ranks are up to the master.'}</p>`}</div>`;
    const rivals = [...clan.clans.values()].filter((x) => x.id !== c.id);
    body += `<div class="box"><h1>Clan war</h1><p class="muted">Be in a game lobby (not in a room), then declare: a war room is created for you in your channel and both clans get a notice. Each clan plays on its own side.</p>
<table><tr><th>Clan</th><th>W/D/L</th><th></th></tr>${rivals
      .map((x) => `<tr><td>${emblemImg(x)} ${esc(x.name)}</td><td>${x.wins}/${x.draws}/${x.losses}</td><td>${act(s, 'war', 'Declare war', `<input type="hidden" name="clan" value="${x.id}">`, 'danger')}</td></tr>`)
      .join('') || '<tr><td colspan="3" class="muted">No other clans yet.</td></tr>'}</table></div>`;
  }
  if (isMaster) {
    const current = /^g(\d+)$/.exec(c.emblem || '');
    const radios = Array.from({ length: emblems.GALLERY_SIZE }, (_, n) =>
      `<label><input type="radio" name="emblem" value="g${n}"${current && Number(current[1]) === n ? ' checked' : ''}> <img class="emblem" src="/emblem/g${n}.bmp" alt=""></label>`).join('');
    body += `<div class="box gallery"><h1>Emblem</h1>${form('/clan', `<input type="hidden" name="action" value="emblem">${radios}`, 'Use this emblem', s.csrf)}
<form method="post" action="/clan/emblem" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${s.csrf}">
<label for="file">Or upload your own: PNG, JPEG or BMP, up to ${emblems.MAX_UPLOAD / 1024} KB, 32x32 looks best</label><input id="file" name="file" type="file" accept="image/png,image/jpeg,image/bmp">
<p><button>Upload</button></p></form></div>`;
  }
  body += `<div class="box">${u.clanRank === clan.RANK.MASTER ? act(s, 'disband', 'Disband the clan', '', 'danger') + ' <span class="muted">Hand the clan to someone else first if you want to leave it.</span>' : act(s, 'leave', 'Leave the clan', '', 'danger')}</div>`;
  send(res, 200, page('Clan', body, s));
}

async function clanAction(req, res, db, s) {
  const b = await readBody(req);
  if (b.get('csrf') !== s.csrf) return clanPage(res, db, s, { text: 'Session expired, try again.' });
  const u = await player(db, s);
  const target = Number(b.get('target'));
  const actions = {
    create: () => clan.createClan(db, u, b.get('name') || ''),
    apply: () => clan.applyClan(db, u, Number(b.get('clan'))),
    // Leaving as master would silently disband (the in-game rule); the site has an explicit disband button instead.
    leave: () => (u.clanRank === clan.RANK.MASTER ? 'Use Disband, or make someone else master first.' : clan.leaveClan(db, u)),
    disband: () => clan.disbandBy(db, u),
    accept: () => clan.joinAction(db, u, 0, target),
    refuse: () => clan.joinAction(db, u, 1, target),
    officer: () => clan.rankAction(db, u, 0, target),
    demote: () => clan.rankAction(db, u, 1, target),
    kick: () => clan.rankAction(db, u, 2, target),
    master: () => clan.promote(db, u, target),
    war: () => clan.declareWar(u, Number(b.get('clan'))).error,
    emblem: () => {
      const e = b.get('emblem') || '';
      return /^g\d+$/.test(e) && Number(e.slice(1)) < emblems.GALLERY_SIZE ? clan.setEmblem(db, u, e) : 'Pick an emblem.';
    },
  };
  const run = actions[b.get('action')];
  const err = run ? await run() : 'Unknown action.';
  clanPage(res, db, s, { text: err || (b.get('action') === 'emblem' ? EMBLEM_CHANGED : 'Done.'), ok: !err });
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) return reject(new Error('body too large'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data reader for the emblem form: { fieldName: Buffer }.
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return {};
  const sep = Buffer.from(`--${m[1] || m[2]}`);
  const parts = {};
  let start = body.indexOf(sep);
  while (start !== -1) {
    const next = body.indexOf(sep, start + sep.length);
    if (next === -1) break;
    const part = body.subarray(start + sep.length + 2, next - 2); // drop the CRLFs around the part
    const headEnd = part.indexOf('\r\n\r\n');
    const name = headEnd !== -1 && /name="([^"]*)"/.exec(part.subarray(0, headEnd).toString('latin1'));
    if (name) parts[name[1]] = part.subarray(headEnd + 4);
    start = next;
  }
  return parts;
}

async function uploadEmblem(req, res, db, s) {
  let parts;
  try {
    parts = parseMultipart(await readRaw(req, emblems.MAX_UPLOAD + 4096), req.headers['content-type']);
  } catch {
    return clanPage(res, db, s, { text: `The image must be at most ${emblems.MAX_UPLOAD / 1024} KB.` });
  }
  if (String(parts.csrf || '') !== s.csrf) return clanPage(res, db, s, { text: 'Session expired, try again.' });
  const u = await player(db, s);
  const err = emblems.checkUpload(parts.file) || clan.setEmblem(db, u, 'u', Buffer.from(parts.file));
  clanPage(res, db, s, { text: err || EMBLEM_CHANGED, ok: !err });
}

async function route(req, res, db, authDb) {
  const ip = req.socket.remoteAddress;
  const path = req.url.split('?')[0];
  const post = req.method === 'POST';
  const s = session(req);

  if (path === '/' && !post) {
    return send(res, 200, page('War Rock', `<div class="box"><p>Chapter 1 private server.</p><p>${s ? '<a href="/clan">Manage your clan</a>' : '<a href="/register">Create an account</a> &middot; <a href="/login">Login</a>'}</p></div>`, s));
  }
  if (path === '/register') return post ? register(req, res, authDb, ip) : registerPage(res);
  if (path === '/login') return post ? login(req, res, authDb, ip) : loginPage(res);
  if (path === '/clans' && !post) return clansPage(res, s);
  if (path === '/logout' && post) {
    const b = await readBody(req);
    if (s && b.get('csrf') === s.csrf) for (const [k, v] of sessions) if (v === s) sessions.delete(k);
    return redirect(res, '/', { 'Set-Cookie': 'wr_s=; Path=/; Max-Age=0' });
  }
  if (path === '/clan') {
    // Single sign-on from the game client (?t= token handed out at game login, see internal-client.js). Redirects to
    // the bare URL so the token doesn't stay in the address bar or history.
    const t = !post && new URLSearchParams(req.url.split('?')[1] || '').get('t');
    if (t) {
      const user = webTokenUser(t);
      return user ? signIn(res, user.userId, user.username, user.displayname) : redirect(res, '/login');
    }
    if (!s) return redirect(res, '/login');
    return post ? clanAction(req, res, db, s) : clanPage(res, db, s);
  }
  if (path === '/clan/emblem' && post) {
    if (!s) return redirect(res, '/login');
    return uploadEmblem(req, res, db, s);
  }
  const gallery = /^\/emblem\/g(\d+)\.bmp$/.exec(path);
  if (gallery && !post && Number(gallery[1]) < emblems.GALLERY_SIZE) {
    res.writeHead(200, { 'Content-Type': 'image/bmp', 'Cache-Control': 'max-age=86400' });
    return res.end(emblems.galleryEmblem(Number(gallery[1])));
  }
  // Lobby user list emblems: the client fetches <id>.crc, and <id>.jpg only when the crc text changed (cached in
  // texture/Avata). Unknown clan: 404, so the client falls back to DefaultClanMark.jpg.
  const avatar = /^\/avatar\/(\d+)\.(jpg|crc)$/.exec(path);
  if (avatar && !post) {
    const c = clan.clans.get(Number(avatar[1]));
    if (!c) return send(res, 404, 'no such clan');
    const img = emblems.clanEmblem(c);
    res.writeHead(200, { 'Content-Type': avatar[2] === 'crc' ? 'text/plain' : img.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(avatar[2] === 'crc' ? crypto.createHash('md5').update(img.data).digest('hex') : img.data);
  }
  if (path === '/ClanAvatar.aspx' && !post) {
    // Clan war rooms (client 22 code at 0x4cd620) ask by name.
    const name = (new URLSearchParams(req.url.split('?')[1] || '').get('Clan') || '').toLowerCase();
    const c = [...clan.clans.values()].find((x) => x.name.toLowerCase() === name);
    if (!c) return send(res, 404, 'no such clan');
    const img = emblems.clanEmblem(c);
    res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(img.data);
  }
  send(res, 404, page('Not found', '<div class="box"><p><a href="/">Home</a></p></div>', s));
}

function startWeb(db, authDb, port) {
  const server = http.createServer((req, res) => {
    route(req, res, db, authDb).catch((err) => {
      console.error('web:', err.message);
      if (!res.headersSent) send(res, 500, page('Error', '<div class="box"><p>Something went wrong.</p></div>'));
    });
  });
  // Expired sessions and old rate-limit entries would otherwise pile up forever.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
    for (const [k, list] of attempts) if (list.every((t) => now - t > 60 * 60 * 1000)) attempts.delete(k);
  }, 60 * 60 * 1000).unref();
  server.listen(port, () => console.log(`Web: listening on ${port}`));
  return server;
}

module.exports = { startWeb };
