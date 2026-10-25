import APP from './app.html';
import STATS from './stats.html';
import { BUILDINGS } from './buildings.js';

const ENGAGE = 'https://gatech.campuslabs.com/engage/api/discovery/event/search';
const DAY = 86400000;
const HUB = { name: 'Student Center', lat: 33.77414, lng: -84.40039 };
const POST_LIFE = 60 * 60000;       // informal posts last 60 min unless confirmed
const CONFIRM_EXTEND = 30 * 60000;  // each "still here" pushes the end out 30 min
const GONE_LIMIT = 2;               // two "gone" reports take a pin down
const ONLINE = /\b(online|webinar|zoom|virtual|teams meeting|microsoft teams|tbd|tba)\b/i;

const THEME = {
  Social: 'Social', Arts: 'Arts', Athletics: 'Sports', CommunityService: 'Service',
  Cultural: 'Cultural', ThoughtfulLearning: 'Learning', GroupBusiness: 'Learning',
  Spirituality: 'Cultural', Fundraising: 'Social',
};

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
});
const html = h => new Response(h, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

function findBuilding(loc) {
  const l = ' ' + (loc || '').toLowerCase().replace(/[^a-z0-9& ]/g, ' ') + ' ';
  for (const b of BUILDINGS) for (const k of b.keys) if (l.includes(' ' + k + ' ') || (k.length > 4 && l.includes(k))) return b;
  return null;
}

function metersBetween(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function etHour(ms) {
  return +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(ms);
}
function etDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ms);
}

// ---------- ingest ----------

async function ingest(env) {
  const t0 = Date.now();
  const now = t0;
  const qs = (skip) => `?endsAfter=${new Date(now).toISOString()}&startsBefore=${new Date(now + 8 * DAY).toISOString()}` +
    `&orderByField=endsOn&orderByDirection=ascending&status=Approved&take=200&skip=${skip}&query=`;
  let all = [];
  for (let skip = 0; skip < 2000; skip += 200) {
    const r = await fetch(ENGAGE + qs(skip), { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('engage ' + r.status);
    const page = (await r.json()).value || [];
    all = all.concat(page);
    if (page.length < 200) break;
  }
  const stats = { fetched: all.length, kept: 0, engage_coords: 0, building_coords: 0, no_coords: 0, dropped_online: 0 };
  const stmts = [];
  const upsert = env.DB.prepare(`INSERT INTO events (id,source,name,org,location,lat,lng,geo_source,starts,ends,free_food,category,rsvp,url,status,created,updated)
    VALUES (?1,'engage',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'live',?14,?14)
    ON CONFLICT(id) DO UPDATE SET name=?2,org=?3,location=?4,lat=?5,lng=?6,geo_source=?7,starts=?8,ends=?9,free_food=?10,category=?11,rsvp=?12,url=?13,
      status=CASE WHEN events.status='gone' THEN 'gone' ELSE 'live' END,updated=?14`);
  for (const e of all) {
    const loc = (e.location || '').trim();
    if (!loc || ONLINE.test(loc)) { stats.dropped_online++; continue; }
    const starts = Date.parse(e.startsOn), ends = Date.parse(e.endsOn);
    if (ends - starts > 2 * DAY) { stats.dropped_online++; continue; } // multi-day listings are not "go now" events
    let lat = null, lng = null, geo = 'none';
    // Engage pins more than 5 km away are either trips or bad pins, so fall back to the building name
    const pinOk = e.latitude && e.longitude && metersBetween(HUB, { lat: +e.latitude, lng: +e.longitude }) <= 5000;
    if (pinOk) { lat = +e.latitude; lng = +e.longitude; geo = 'engage'; stats.engage_coords++; }
    else { const b = findBuilding(loc); if (b) { lat = b.lat; lng = b.lng; geo = 'building'; stats.building_coords++; } else stats.no_coords++; }
    const food = (e.benefitNames || []).includes('Free Food') ? 1 : 0;
    stats.kept++;
    stmts.push(upsert.bind('engage:' + e.id, clip(e.name, 200), clip(e.organizationName, 120), clip(loc, 200), lat, lng, geo,
      starts, ends, food, THEME[e.theme] || 'Other', e.rsvpTotal ?? null, `https://gatech.campuslabs.com/engage/event/${e.id}`, now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  // anything still upcoming that dropped out of the feed was cancelled or unpublished
  await env.DB.prepare(`UPDATE events SET status='removed' WHERE source='engage' AND status='live' AND ends>?1 AND updated<?1`).bind(now).run();
  await expirePosts(env);
  await env.DB.prepare(`INSERT INTO ingest_runs VALUES (?,?,?,?,?,?,?,?)`).bind(now, stats.fetched, stats.kept, stats.engage_coords,
    stats.building_coords, stats.no_coords, stats.dropped_online, Date.now() - t0).run();
  return stats;
}

async function expirePosts(env) {
  await env.DB.prepare(`UPDATE events SET status='expired' WHERE source='post' AND status='live' AND ends<?`).bind(Date.now()).run();
}

// ---------- api ----------

async function listEvents(env, url) {
  const now = Date.now();
  const from = +url.searchParams.get('from') || now;
  const to = +url.searchParams.get('to') || now + 2 * 3600000;
  await expirePosts(env);
  const { results } = await env.DB.prepare(`SELECT id,source,name,org,location,lat,lng,geo_source,starts,ends,free_food,category,rsvp,url,confirms,gone,poster_role
    FROM events WHERE status='live' AND starts<?2 AND ends>?1 ORDER BY starts LIMIT 400`).bind(from, to).all();
  return json({ now, from, to, events: results.filter(e => e.lat != null), unplaced: results.filter(e => e.lat == null).length });
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

async function log(env, b) {
  if (!b.device || !b.type) return json({ error: 'device and type required' }, 400);
  await env.DB.prepare(`INSERT INTO logs (ts,device,tester,session,type,event_id,meta) VALUES (?,?,?,?,?,?,?)`)
    .bind(Date.now(), clip(b.device, 64), clip(b.tester, 24), clip(b.session, 64), clip(b.type, 24), clip(b.event_id, 80),
      b.meta ? clip(JSON.stringify(b.meta), 500) : null).run();
  return json({ ok: true });
}

async function post(env, b) {
  const name = (b.name || '').trim();
  if (!b.device || name.length < 3 || !(Math.abs(b.lat - HUB.lat) < 0.03 && Math.abs(b.lng - HUB.lng) < 0.03))
    return json({ error: 'need a name and a spot on campus' }, 400);
  const now = Date.now();
  const mins = Math.min(Math.max(+b.minutes || 60, 15), 120);
  const id = 'post:' + crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO events (id,source,name,location,lat,lng,geo_source,starts,ends,free_food,category,poster_device,poster_role,created,updated)
    VALUES (?,'post',?,?,?,?,'user',?,?,?,?,?,?,?,?)`).bind(id, clip(name, 120), clip(b.location, 120), +b.lat, +b.lng, now,
    now + Math.min(mins * 60000, POST_LIFE), b.free_food ? 1 : 0, clip(b.category, 20) || 'Other', clip(b.device, 64),
    ['student', 'staff', 'officer'].includes(b.role) ? b.role : 'student', now, now).run();
  return json({ ok: true, id });
}

async function check(env, b) {
  if (!b.device || !b.event_id || !['here', 'gone', 'skipped'].includes(b.answer)) return json({ error: 'bad check' }, 400);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO checks (ts,device,event_id,answer,via) VALUES (?,?,?,?,?)`)
    .bind(now, clip(b.device, 64), clip(b.event_id, 80), b.answer, clip(b.via, 12)).run();
  if (b.answer === 'here')
    await env.DB.prepare(`UPDATE events SET confirms=confirms+1, gone=0, updated=?2,
      ends=CASE WHEN source='post' THEN MAX(ends, ?2+?3) ELSE ends END WHERE id=?1`).bind(b.event_id, now, CONFIRM_EXTEND).run();
  if (b.answer === 'gone')
    await env.DB.prepare(`UPDATE events SET gone=gone+1, updated=?2, status=CASE WHEN gone+1>=?3 THEN 'gone' ELSE status END WHERE id=?1`)
      .bind(b.event_id, now, GONE_LIMIT).run();
  return json({ ok: true });
}

// ---------- stats ----------

async function stats(env) {
  const now = Date.now();
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const logs = await q(`SELECT ts,device,tester,session,type,event_id,meta FROM logs WHERE coalesce(tester,'')<>'TEST' ORDER BY ts`);
  // the team's own debugging (tester code TEST, or cleanup calls from team-* devices) is left out
  const TEAM = `(SELECT device FROM logs WHERE tester='TEST')`;
  const posts = await q(`SELECT id,name,poster_role,confirms,gone,status,starts,ends,free_food,category FROM events WHERE source='post' AND poster_device NOT IN ${TEAM}`);
  const checks = await q(`SELECT c.answer,c.via,e.source FROM checks c LEFT JOIN events e ON e.id=c.event_id
    WHERE c.device NOT IN ${TEAM} AND c.device NOT LIKE 'team-%' AND coalesce(e.poster_device,'') NOT IN ${TEAM}`);
  const runs = await q(`SELECT * FROM ingest_runs ORDER BY ts`);
  const upcoming = await q(`SELECT source,lat,lng,geo_source,starts,ends,free_food,category FROM events WHERE source='engage' AND status='live' AND ends>? AND starts<?`, now, now + 7 * DAY);

  // usage
  const devices = {}, sessions = {};
  for (const l of logs) {
    const d = devices[l.device] ||= { first: l.ts, days: new Set(), tester: l.tester };
    if (l.type === 'open') d.days.add(etDay(l.ts));
    if (l.tester) d.tester = l.tester;
    const s = sessions[l.session || l.device + l.ts] ||= { views: 0, directions: 0 };
    if (l.type === 'view') s.views++;
    if (l.type === 'directions') s.directions++;
  }
  const devList = Object.values(devices);
  const returned = devList.filter(d => d.days.size >= 2).length;
  const weekTwoEligible = devList.filter(d => now - d.first >= 7 * DAY);
  const weekTwo = weekTwoEligible.filter(d => logs.some(l => devices[l.device] === d && l.type === 'open' && l.ts - d.first >= 7 * DAY && l.ts - d.first < 14 * DAY)).length;
  const sessList = Object.values(sessions);
  const byCat = {};
  const evCat = Object.fromEntries((await q(`SELECT id,category,free_food FROM events`)).map(e => [e.id, e]));
  for (const l of logs) if (l.type === 'view' && evCat[l.event_id]) {
    const c = evCat[l.event_id].free_food ? 'Free food' : evCat[l.event_id].category;
    byCat[c] = (byCat[c] || 0) + 1;
  }
  const count = t => logs.filter(l => l.type === t).length;
  const prompts = logs.filter(l => l.type === 'prompt');

  // coverage: on a typical weekday hour, how many events are going on (or start within 60 min) within a 10 minute walk of the Student Center?
  const cover = {}, hours = {};
  for (let t = now - (now % 3600000) + 3600000; t < now + 7 * DAY; t += 3600000) {
    const h = etHour(t);
    const n = upcoming.filter(e => e.lat != null && e.starts < t + 3600000 && e.ends > t && metersBetween(HUB, e) <= 800).length;
    (hours[h] ||= []).push(n);
  }
  for (const [h, arr] of Object.entries(hours)) cover[h] = { avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1), zeroShare: +(arr.filter(x => x === 0).length / arr.length).toFixed(2) };

  const totalUp = upcoming.length;
  const geo = s => upcoming.filter(e => e.geo_source === s).length;
  const lastRun = runs[runs.length - 1] || null;

  return {
    generated: now,
    ingest: {
      runs: runs.length, first: runs[0]?.ts || null, last: lastRun,
      next7days: { events: totalUp, engagePin: geo('engage'), buildingMatch: geo('building'), unplaced: geo('none'), freeFood: upcoming.filter(e => e.free_food).length },
      coverageNearStudentCenter: cover,
    },
    usage: {
      devices: devList.length, testers: [...new Set(devList.map(d => d.tester).filter(Boolean))].length,
      sessions: sessList.length, opens: count('open'), views: count('view'), directions: count('directions'), saves: count('save'),
      sessionsWithDirections: sessList.filter(s => s.directions > 0).length,
      returnedAnotherDay: returned, weekTwoEligible: weekTwoEligible.length, weekTwoReturned: weekTwo,
      viewsByCategory: byCat,
      promptsShown: prompts.filter(p => (p.meta || '').includes('shown')).length,
      promptsAnswered: prompts.filter(p => (p.meta || '').includes('answered')).length,
    },
    posts: {
      total: posts.length,
      byRole: posts.reduce((a, p) => (a[p.poster_role] = (a[p.poster_role] || 0) + 1, a), {}),
      confirmedAtLeastOnce: posts.filter(p => p.confirms > 0).length,
      takenDownAsGone: posts.filter(p => p.status === 'gone').length,
      days: [...new Set(posts.map(p => etDay(p.starts)))].length,
    },
    checks: {
      total: checks.length,
      here: checks.filter(c => c.answer === 'here').length,
      gone: checks.filter(c => c.answer === 'gone').length,
      viaPrompt: checks.filter(c => c.via === 'prompt').length,
    },
  };
}

const CSV_TABLES = {
  logs: 'SELECT id,ts,device,tester,session,type,event_id,meta FROM logs ORDER BY id',
  checks: 'SELECT id,ts,device,event_id,answer,via FROM checks ORDER BY id',
  posts: `SELECT id,name,location,lat,lng,starts,ends,free_food,category,poster_role,confirms,gone,status FROM events WHERE source='post' ORDER BY created`,
  events: `SELECT id,name,org,location,lat,lng,geo_source,starts,ends,free_food,category,rsvp,status FROM events WHERE source='engage' ORDER BY starts`,
  ingest_runs: 'SELECT * FROM ingest_runs ORDER BY ts',
};

async function csv(env, table) {
  const sql = CSV_TABLES[table];
  if (!sql) return json({ error: 'tables: ' + Object.keys(CSV_TABLES).join(', ') }, 404);
  const { results } = await env.DB.prepare(sql).all();
  const cols = results.length ? Object.keys(results[0]) : [];
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const body = [cols.join(','), ...results.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/csv', 'content-disposition': `inline; filename="campuspulse-${table}.csv"` } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
      if (p === '/' || p === '/index.html') return html(APP);
      if (p === '/stats') return html(STATS);
      if (p === '/api/events') return listEvents(env, url);
      if (p === '/api/stats') return json(await stats(env));
      if (p.startsWith('/api/export/')) return csv(env, p.split('/').pop().replace('.csv', ''));
      if (req.method === 'POST' && p === '/api/ingest') {
        const last = await env.DB.prepare('SELECT max(ts) t FROM ingest_runs').first();
        if (last?.t && Date.now() - last.t < 5 * 60000) return json({ skipped: 'ran in the last 5 minutes' });
        return json(await ingest(env));
      }
      if (req.method === 'POST' && p === '/api/log') return log(env, await readBody(req));
      if (req.method === 'POST' && p === '/api/post') return post(env, await readBody(req));
      if (req.method === 'POST' && p === '/api/check') return check(env, await readBody(req));
      if (p === '/manifest.json') return json({ name: 'CampusPulse', short_name: 'CampusPulse', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#1f4e79' });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(ingest(env));
  },
};
export { ingest };
