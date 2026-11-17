// 치지직 채팅 추첨 사이트 (누구나 방을 만들어 사용)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ChzzkClient } from 'chzzk';

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 200;       // 동시에 존재하는 최대 방 수
const MAX_LIVE = 40;         // 동시에 채팅을 감지하는 최대 방 수
const TTL = 6 * 3600e3;      // 마지막 사용 후 방이 유지되는 시간
const PAGE = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf-8');
const rooms = new Map();

const toInt = (v) => { const n = Number.parseInt(String(v ?? '').trim(), 10); return Number.isFinite(n) ? n : null; };
const cl = (v) => Math.min(Math.max(toInt(v) ?? 1, 1), 20);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

class Room {
  constructor() {
    this.id = crypto.randomBytes(4).toString('hex');
    this.key = crypto.randomBytes(16).toString('hex'); // 관리 키 (이 방의 열쇠)
    this.saved = { channelId: '', keyword: '' };
    this.last = null;
    this.touched = Date.now();
    this.chat = null; this.channelId = null; this.mode = 'keyword';
    this.keyword = null; this.range = null; this.accepting = true;
    this.clear();
  }
  clear() { this.people = new Map(); this.winners = new Set(); this.guesses = new Map(); }
  async stop() {
    try { await this.chat?.disconnect?.(); } catch {}
    this.chat = null; this.channelId = null; this.mode = 'keyword';
  }
  async start(channelId, keyword, mode = 'keyword', range = null) {
    await this.stop();
    if ([...rooms.values()].filter((r) => r.chat).length >= MAX_LIVE) throw new Error('지금 이용자가 많아요. 잠시 후 다시 시도하세요.');
    Object.assign(this, { keyword, mode, range, channelId, accepting: true });
    this.clear();
    const chat = new ChzzkClient().chat({ channelId });
    chat.on('chat', (m) => this.onChat(m));
    await chat.connect();
    this.chat = chat;
  }
  onChat(m) {
    if (!this.accepting || m.hidden || this.people.size >= 5000) return;
    const nick = m.profile?.nickname ?? '(알 수 없음)';
    const k = m.profile?.userIdHash ?? nick;
    const text = String(m.message ?? '').trim();
    if (this.mode === 'guess') {
      const g = /^\d+$/.test(text) ? Number(text) : null;
      if (g === null || g < this.range.min || g > this.range.max || this.guesses.has(k)) return;
      this.guesses.set(k, { nickname: nick, guess: g });
      this.people.set(k, nick);
      return;
    }
    if (this.people.has(k) || !text.toLowerCase().includes(this.keyword.toLowerCase())) return;
    this.people.set(k, nick);
  }
  draw(n) {
    const top = shuffle([...this.people].filter(([k]) => !this.winners.has(k))).slice(0, n);
    top.forEach(([k]) => this.winners.add(k));
    if (top.length) this.last = { id: Date.now(), type: 'draw', winners: top.map(([, v]) => v) };
    return top.length;
  }
  reveal(answer, n) {
    const l = shuffle([...this.guesses.values()].map((g) => ({ ...g, diff: Math.abs(g.guess - answer) }))).sort((a, b) => a.diff - b.diff);
    this.last = { id: Date.now(), type: 'guess', answer, winners: l.slice(0, n) };
  }
  state() {
    const guess = this.mode === 'guess';
    const list = guess
      ? [...this.guesses.values()].map((g) => ({ n: g.nickname, g: g.guess }))
      : [...this.people].map(([k, n]) => ({ n, w: this.winners.has(k) }));
    return { connected: Boolean(this.channelId), mode: this.mode, keyword: this.keyword, range: this.range,
      accepting: this.accepting, count: this.people.size, list: list.slice(-1000), last: this.last, saved: this.saved };
  }
}

async function act(r, b) {
  const ch = String(b.channel ?? '').trim();
  const need = () => { if (!r.channelId) throw new Error('먼저 시작하세요.'); };
  const connect = async (...args) => {
    if (!/^[0-9a-f]{32}$/i.test(ch)) throw new Error('채널 ID는 32자리 영문·숫자예요. (방송 주소의 chzzk.naver.com/live/ 뒤 문자열)');
    try { await r.start(ch, ...args); }
    catch (e) { await r.stop(); throw new Error('채팅 연결 실패: ' + e.message + ' (채널 ID와 방송 여부를 확인하세요)'); }
  };
  switch (b.action) {
    case 'start': {
      const kw = String(b.keyword ?? '').trim().slice(0, 50);
      if (!kw) throw new Error('키워드를 입력하세요.');
      await connect(kw);
      r.saved = { channelId: ch, keyword: kw };
      return '키워드 감지를 시작했어요.';
    }
    case 'guess': {
      const min = toInt(b.min) ?? 1, max = toInt(b.max) ?? 100;
      if (min >= max) throw new Error('최대 숫자는 최소 숫자보다 커야 해요.');
      await connect(null, 'guess', { min, max });
      r.saved.channelId = ch;
      return '숫자 맞히기를 시작했어요.';
    }
    case 'close': need(); r.accepting = false; return '접수를 마감했어요.';
    case 'open': need(); r.accepting = true; return '접수를 다시 열었어요.';
    case 'draw':
      need();
      if (r.mode === 'guess') throw new Error('숫자 맞히기에서는 정답공개를 쓰세요.');
      if (!r.draw(cl(b.n))) throw new Error('추첨할 참가자가 없어요.');
      return '추첨 완료!';
    case 'reveal': {
      need();
      if (r.mode !== 'guess') throw new Error('숫자 맞히기 중이 아니에요.');
      if (!r.guesses.size) throw new Error('아직 숫자를 입력한 사람이 없어요.');
      r.accepting = false;
      const { min, max } = r.range;
      r.reveal(toInt(b.answer) ?? min + Math.floor(Math.random() * (max - min + 1)), cl(b.n));
      return '정답을 공개했어요.';
    }
    case 'reset': need(); r.clear(); return '초기화했어요.';
    case 'stop': await r.stop(); return '종료했어요.';
    default: throw new Error('알 수 없는 동작이에요.');
  }
}

// ---- 서버 ----
const hits = new Map();
const limited = (ip, kind, max, ms) => {
  const k = kind + ip, now = Date.now();
  const a = (hits.get(k) ?? []).filter((t) => now - t < ms);
  a.push(now); hits.set(k, a);
  return a.length > max;
};
const body = (req) => new Promise((ok, no) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 5000) { no(new Error('요청이 너무 커요.')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } });
});

http.createServer(async (req, res) => {
  const send = (c, b, t = 'application/json; charset=utf-8') => {
    res.writeHead(c, { 'Content-Type': t, 'Cache-Control': 'no-store' });
    res.end(typeof b === 'string' ? b : JSON.stringify(b));
  };
  try {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    const m = /^\/api\/rooms(?:\/([0-9a-f]{8})\/(state|action))?$/.exec(path);
    if (!m) return send(404, { error: 'not found' });
    const ip = (req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() || req.socket.remoteAddress;
    if (limited(ip, 'all', 300, 60e3)) return send(429, { error: '요청이 너무 많아요. 잠시 후 다시 시도하세요.' });
    if (!m[1]) { // 방 만들기
      if (req.method !== 'POST') return send(405, { error: 'POST만 가능해요.' });
      if (rooms.size >= MAX_ROOMS) return send(503, { error: '지금 방이 가득 찼어요. 잠시 후 다시 시도하세요.' });
      if (limited(ip, 'new', 5, 3600e3)) return send(429, { error: '방은 한 시간에 5개까지 만들 수 있어요.' });
      const r = new Room();
      rooms.set(r.id, r);
      return send(200, { id: r.id, key: r.key });
    }
    const r = rooms.get(m[1]);
    if (!r) return send(404, { error: '방이 없어요. (6시간 동안 쓰지 않으면 사라져요)' });
    const given = String(req.headers['x-admin-key'] ?? '');
    if (given.length !== r.key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(r.key))) {
      return send(401, { error: '관리 키가 틀렸어요.' });
    }
    r.touched = Date.now();
    if (m[2] === 'state') return send(200, r.state());
    if (req.method !== 'POST') return send(405, { error: 'POST만 가능해요.' });
    const msg = await act(r, await body(req));
    send(200, { msg, state: r.state() });
  } catch (e) {
    send(400, { error: e.message });
  }
}).listen(PORT, () => console.log('서버 시작: 포트 ' + PORT));

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (now - r.touched > TTL) { r.stop(); rooms.delete(id); }
  for (const [k, a] of hits) if (now - a.at(-1) > 3600e3) hits.delete(k);
}, 60e3);
process.on('unhandledRejection', console.error);
