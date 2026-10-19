// Cloudflare Worker: online storage for the site + Telegram reminder bot.
//
// KV keys:
//   data     - the whole site data (same shape as data.json), without upload flags
//   uploaded - { videoId: "YYYY-MM-DD" } for videos marked as uploaded
//   owner    - Telegram chat id of the bot owner (first person who sent /start)
//
// Secrets (wrangler secret put): APP_PASSWORD, BOT_TOKEN.

const TZ = 'Europe/Kyiv';
const REMIND_DAYS = ['Thu', 'Fri'];
const REMIND_HOUR = 19;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
});
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/tg' && req.method === 'POST') return telegramUpdate(req, env);
    if (url.pathname === '/setup') return setup(url, env);

    if (url.pathname.startsWith('/api/')) {
      if (req.headers.get('Authorization') !== 'Bearer ' + env.APP_PASSWORD) {
        return json({ ok: false, error: 'wrong password' }, 401);
      }
      return api(req, url, env);
    }
    return new Response('ok');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledReminder(env));
  }
};

// ---------- storage ----------
async function loadData(env) {
  const [data, uploaded] = await Promise.all([
    env.DATA.get('data', 'json'),
    env.DATA.get('uploaded', 'json')
  ]);
  return { data, uploaded: uploaded || {} };
}

async function markUploaded(env, ids, value) {
  const uploaded = (await env.DATA.get('uploaded', 'json')) || {};
  const stamp = kyivDate();
  ids.forEach(id => { if (value) uploaded[id] = uploaded[id] || stamp; else delete uploaded[id]; });
  await env.DATA.put('uploaded', JSON.stringify(uploaded));
}

// ---------- site API ----------
async function api(req, url, env) {
  if (url.pathname === '/api/data' && req.method === 'GET') {
    const { data, uploaded } = await loadData(env);
    if (!data) return json({ empty: true });
    data.videos.forEach(v => { v.uploaded = !!uploaded[v.id]; });
    return json(data);
  }

  if (url.pathname === '/api/data' && req.method === 'POST') {
    let obj;
    try { obj = await req.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
    if (!obj || !obj.settings || !Array.isArray(obj.videos)) return json({ ok: false, error: 'bad format' }, 400);
    // Upload flags live in their own key, so the bot and the site never overwrite each other.
    obj.videos.forEach(v => { delete v.uploaded; });
    await env.DATA.put('data', JSON.stringify(obj));
    return json({ ok: true });
  }

  if (url.pathname === '/api/uploaded' && req.method === 'POST') {
    const { ids, value } = await req.json();
    if (!Array.isArray(ids)) return json({ ok: false }, 400);
    await markUploaded(env, ids, !!value);
    return json({ ok: true });
  }

  if (url.pathname === '/api/steamname' && req.method === 'GET') {
    const appid = url.searchParams.get('appid');
    if (!/^\d+$/.test(appid || '')) return json({ name: '' });
    try {
      const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`);
      const j = await r.json();
      return json({ name: j[appid] && j[appid].success ? j[appid].data.name : '' });
    } catch (e) {
      return json({ name: '' });
    }
  }

  return json({ ok: false, error: 'not found' }, 404);
}

// ---------- telegram ----------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// Telegram signs webhook calls with this value, so strangers can't fake button presses.
async function webhookSecret(env) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tg:' + env.BOT_TOKEN));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Open https://<worker>/setup?key=<APP_PASSWORD> once after deploy.
async function setup(url, env) {
  if (url.searchParams.get('key') !== env.APP_PASSWORD) return new Response('wrong key', { status: 401 });
  if (url.searchParams.get('reset') === 'owner') await env.DATA.delete('owner');
  const hook = await tg(env, 'setWebhook', {
    url: url.origin + '/tg',
    secret_token: await webhookSecret(env),
    allowed_updates: ['message', 'callback_query']
  });
  await tg(env, 'setMyCommands', {
    commands: [{ command: 'check', description: 'Скільки відео ще не завантажено' }]
  });
  const me = await tg(env, 'getMe', {});
  return new Response(
    hook.ok ? `Готово! Бот @${me.result && me.result.username} підключений. Напиши йому /start у Телеграмі.` : 'Помилка: ' + JSON.stringify(hook),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
}

// Groups not-uploaded videos by game. Returns null when everything is uploaded.
async function buildReminder(env) {
  const { data, uploaded } = await loadData(env);
  if (!data) return null;
  const names = {};
  (data.games || []).forEach(g => { names[g.id] = g.name; });
  const groups = {};
  data.videos.filter(v => !uploaded[v.id]).forEach(v => {
    const gid = v.gameId && names[v.gameId] ? v.gameId : 'none';
    groups[gid] = (groups[gid] || 0) + 1;
  });
  const gids = Object.keys(groups);
  if (!gids.length) return null;
  const total = gids.reduce((s, g) => s + groups[g], 0);
  const title = gid => gid === 'none' ? 'Без гри' : names[gid];

  const lines = gids.map(g => `• <b>${esc(title(g))}</b> — ${groups[g]}`);
  const text = `Не забудьте, що ви не завантажили <b>${total}</b> відео по:\n\n${lines.join('\n')}`;
  const buttons = gids.map(g => {
    let label = title(g);
    if (label.length > 40) label = label.slice(0, 39) + '…';
    return [{ text: `Завантажила: ${label}`, callback_data: 'up:' + g }];
  });
  if (gids.length > 1) buttons.push([{ text: 'Завантажила все', callback_data: 'up:all' }]);
  return { text, reply_markup: { inline_keyboard: buttons } };
}

const ALL_DONE = 'Усі відео завантажені. Молодець!';

async function sendReminder(env, chatId, alwaysAnswer) {
  const r = await buildReminder(env);
  if (!r) {
    if (alwaysAnswer) await tg(env, 'sendMessage', { chat_id: chatId, text: ALL_DONE });
    return;
  }
  await tg(env, 'sendMessage', { chat_id: chatId, text: r.text, parse_mode: 'HTML', reply_markup: r.reply_markup });
}

async function telegramUpdate(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) {
    return new Response('no', { status: 401 });
  }
  const u = await req.json();
  let owner = await env.DATA.get('owner');

  if (u.message) {
    const chat = String(u.message.chat.id);
    const text = (u.message.text || '').trim();
    if (!owner && text.startsWith('/start')) {
      await env.DATA.put('owner', chat);
      owner = chat;
      await tg(env, 'sendMessage', {
        chat_id: chat,
        text: 'Привіт! Я нагадуватиму про незавантажені відео щочетверга і щоп\'ятниці о 19:00. Напиши /check, щоб перевірити будь-коли.'
      });
    }
    if (chat !== owner) {
      await tg(env, 'sendMessage', { chat_id: chat, text: 'Це особистий бот.' });
    } else if (text.startsWith('/start') || text.startsWith('/check')) {
      await sendReminder(env, chat, true);
    }
  }

  if (u.callback_query) {
    const cq = u.callback_query;
    const msg = cq.message;
    if (!msg || String(msg.chat.id) !== owner) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
      return new Response('ok');
    }
    if ((cq.data || '').startsWith('up:')) {
      const gid = cq.data.slice(3);
      const { data, uploaded } = await loadData(env);
      const known = new Set((data ? data.games : []).map(g => g.id));
      const ids = (data ? data.videos : [])
        .filter(v => !uploaded[v.id])
        .filter(v => gid === 'all' || (gid === 'none' ? !known.has(v.gameId) : v.gameId === gid))
        .map(v => v.id);
      await markUploaded(env, ids, true);
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: `Позначено: ${ids.length}` });
      const r = await buildReminder(env);
      await tg(env, 'editMessageText', r
        ? { chat_id: msg.chat.id, message_id: msg.message_id, text: r.text, parse_mode: 'HTML', reply_markup: r.reply_markup }
        : { chat_id: msg.chat.id, message_id: msg.message_id, text: ALL_DONE });
    }
  }
  return new Response('ok');
}

// ---------- schedule ----------
function kyivParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t).value;
  return { weekday: get('weekday'), hour: +get('hour'), date: `${get('year')}-${get('month')}-${get('day')}` };
}
const kyivDate = () => kyivParts().date;

// Cron fires at 16:00 and 17:00 UTC; only the one that is 19:00 in Kyiv sends (handles summer/winter time).
async function scheduledReminder(env) {
  const now = kyivParts();
  if (!REMIND_DAYS.includes(now.weekday) || now.hour !== REMIND_HOUR) return;
  const owner = await env.DATA.get('owner');
  if (owner) await sendReminder(env, owner, false);
}
