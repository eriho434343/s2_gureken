/* ============================================
   昇進試験 学習PWA / app.js
   - SM-2 spaced repetition
   - IndexedDB storage
   - JSON/CSV import-export
   - TTS for commute mode
   ============================================ */
(() => {
'use strict';

// ============================================
// Constants & state
// ============================================
const DB_NAME = 'shoshin-shiken';
const DB_VERSION = 1;
const STORE_Q = 'questions';
const STORE_P = 'progress';
const STORE_S = 'sessions';
const STORE_M = 'meta';

const CATS = { common: '共通', solution: 'ソリューション', engineering: 'エンジニア' };

const state = {
  questions: [],          // [{id, category, question, answer, ...}]
  progress: {},           // {questionId: {ease, interval, reps, due, ...}}
  settings: {
    examDate: '2026-08-31',
    newPerDay: 10,
    revPerDay: 100,
    mixRatio: '3:7',
    theme: 'auto',
    fontSize: 'm',
    ttsAuto: false,
    authorName: '',
  },
  todayKey: '',
  todaySeen: { new: 0, rev: 0 },  // counters reset daily
  studyDeck: [],          // current session queue
  studyIdx: 0,
  studyStats: { again: 0, hard: 0, good: 0, easy: 0, total: 0 },
  selectedCat: 'all',
  selectedSize: 10,
  listCat: 'all',
  listStatus: 'all',
  listSort: 'created',
  listSearch: '',
  editingId: null,
  editingCat: 'common',
  editingImp: 3,
  utterance: null,
  ttsEnabled: false,
};

// ============================================
// IndexedDB wrapper
// ============================================
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_Q)) {
        const s = d.createObjectStore(STORE_Q, { keyPath: 'id' });
        s.createIndex('category', 'category');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains(STORE_P)) {
        d.createObjectStore(STORE_P, { keyPath: 'questionId' });
      }
      if (!d.objectStoreNames.contains(STORE_S)) {
        d.createObjectStore(STORE_S, { keyPath: 'date' });
      }
      if (!d.objectStoreNames.contains(STORE_M)) {
        d.createObjectStore(STORE_M, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode = 'readonly') {
  const t = db.transaction(stores, mode);
  return Array.isArray(stores) ? stores.map(s => t.objectStore(s)) : t.objectStore(stores);
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) { return reqP(tx(store).getAll()); }
async function dbGet(store, key) { return reqP(tx(store).get(key)); }
async function dbPut(store, value) { return reqP(tx(store, 'readwrite').put(value)); }
async function dbDel(store, key) { return reqP(tx(store, 'readwrite').delete(key)); }
async function dbClear(store) { return reqP(tx(store, 'readwrite').clear()); }

async function metaSet(key, value) { return dbPut(STORE_M, { key, value }); }
async function metaGet(key) { const r = await dbGet(STORE_M, key); return r ? r.value : null; }

// ============================================
// SM-2 algorithm
// ============================================
function newProgress(qid) {
  return {
    questionId: qid,
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: null,        // null = new (never reviewed)
    lastReviewed: null,
    totalReviews: 0,
    history: [],
  };
}

function applySM2(p, rating) {
  // rating: 1=Again, 2=Hard, 3=Good, 4=Easy
  const before = p.interval;
  if (rating === 1) {
    p.reps = 0;
    p.interval = 1;
    p.ease = Math.max(1.3, p.ease - 0.20);
    p.lapses += 1;
  } else {
    if (p.reps === 0) {
      p.interval = rating === 2 ? 1 : (rating === 3 ? 1 : 4);
    } else if (p.reps === 1) {
      p.interval = rating === 2 ? 3 : (rating === 3 ? 6 : 10);
    } else {
      const factor = rating === 2 ? 1.2 : (rating === 3 ? p.ease : p.ease * 1.3);
      p.interval = Math.max(1, Math.round(p.interval * factor));
    }
    p.reps += 1;
    if (rating === 2) p.ease = Math.max(1.3, p.ease - 0.15);
    else if (rating === 4) p.ease = Math.min(3.0, p.ease + 0.15);
  }
  p.totalReviews += 1;
  const now = new Date();
  p.lastReviewed = now.toISOString();
  const due = startOfDay(now);
  due.setDate(due.getDate() + p.interval);
  p.due = due.toISOString();
  p.history.push({ d: now.toISOString().slice(0,10), r: rating, b: before, a: p.interval });
  if (p.history.length > 100) p.history = p.history.slice(-100);
  return p;
}

function previewIntervals(p) {
  // Return what interval each rating would produce, without modifying p
  const make = (r) => {
    const c = JSON.parse(JSON.stringify(p));
    return applySM2(c, r).interval;
  };
  return [make(1), make(2), make(3), make(4)];
}

// ============================================
// Helpers
// ============================================
function startOfDay(d = new Date()) {
  const x = new Date(d); x.setHours(0,0,0,0); return x;
}
function dateKey(d = new Date()) {
  const x = startOfDay(d);
  return x.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const ms = startOfDay(b) - startOfDay(a);
  return Math.round(ms / 86400000);
}
function fmtDays(n) {
  if (n < 1) return '今日';
  if (n === 1) return '1日後';
  if (n < 30) return `${n}日後`;
  if (n < 365) return `${Math.round(n/30)}ヶ月後`;
  return `${Math.round(n/365*10)/10}年後`;
}
function fmtDue(due) {
  if (!due) return '未学習';
  const d = daysBetween(new Date(), due);
  if (d < 0) return `期日超過 (${-d}日)`;
  if (d === 0) return '今日が期日';
  return `${d}日後`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 【】を穴に変換、答え側の① ②等を強調表示
function renderBlanks(text) {
  return escapeHtml(text).replace(/【([^】]*)】/g, (m, inner) => {
    return `<span class="blank">${inner || '　'}</span>`;
  });
}
function renderAnswer(text) {
  // 改行は維持。①②...を少し強調。
  return escapeHtml(text).replace(/([①-⑳])/g, '<span class="ans-num">$1</span>');
}
function uid(prefix = 'q') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cardStatus(q, p) {
  if (!p || !p.due) return 'new';
  if (p.lapses >= 4 && p.interval < 7) return 'leech';
  if (p.interval >= 21) return 'mastered';
  if (p.reps >= 2) return 'review';
  return 'learning';
}

// ============================================
// Loading & init
// ============================================
async function init() {
  await openDB();
  await loadSettings();
  applyTheme();
  applyFontSize();

  // Load existing
  state.questions = await dbGetAll(STORE_Q);
  const progArr = await dbGetAll(STORE_P);
  state.progress = {};
  for (const p of progArr) state.progress[p.questionId] = p;

  // Initial seed if empty
  if (state.questions.length === 0) {
    await loadSeed(false);
  }

  // Reset today's counters if new day
  await resetTodayIfNeeded();

  // Wire UI
  bindEvents();

  // Initial render
  renderHome();

  // Hide loader
  document.getElementById('loader').remove();
  document.getElementById('app').hidden = false;

  // Register SW
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* ok */ }
  }
}

async function loadSettings() {
  const saved = await metaGet('settings');
  if (saved) state.settings = { ...state.settings, ...saved };
}
async function saveSettings() {
  await metaSet('settings', state.settings);
}

async function resetTodayIfNeeded() {
  const today = dateKey();
  const m = await metaGet('todayCounters');
  if (!m || m.date !== today) {
    state.todaySeen = { new: 0, rev: 0 };
    await metaSet('todayCounters', { date: today, ...state.todaySeen });
  } else {
    state.todaySeen = { new: m.new || 0, rev: m.rev || 0 };
  }
  state.todayKey = today;
}
async function bumpTodayCounter(kind) {
  state.todaySeen[kind] = (state.todaySeen[kind] || 0) + 1;
  await metaSet('todayCounters', { date: state.todayKey, ...state.todaySeen });
}

function applyTheme() {
  const t = state.settings.theme || 'auto';
  document.documentElement.dataset.theme = t;
}
function applyFontSize() {
  document.documentElement.dataset.fontsize = state.settings.fontSize || 'm';
}

async function loadSeed(merge = true) {
  try {
    const r = await fetch('data/seed.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('seed fetch failed');
    const data = await r.json();
    let added = 0, skipped = 0;
    for (const q of (data.questions || [])) {
      if (merge && state.questions.find(x => x.id === q.id)) { skipped++; continue; }
      const rec = {
        id: q.id || uid(),
        category: q.category || 'common',
        tags: q.tags || [],
        source: q.source || '',
        year: q.year || null,
        importance: q.importance || 3,
        question: q.question || '',
        answer: q.answer || '',
        createdAt: q.createdAt || new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      };
      await dbPut(STORE_Q, rec);
      const idx = state.questions.findIndex(x => x.id === rec.id);
      if (idx >= 0) state.questions[idx] = rec; else state.questions.push(rec);
      added++;
    }
    toast(`シード読込: 追加${added}件 / スキップ${skipped}件`);
  } catch (e) {
    console.warn('seed load failed', e);
    toast('シード問題の読み込みに失敗しました');
  }
}

// ============================================
// Toast & modal
// ============================================
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function confirm(msg) {
  return new Promise((resolve) => {
    const m = document.getElementById('modal');
    document.getElementById('modal-msg').textContent = msg;
    m.hidden = false;
    const ok = document.getElementById('modal-ok');
    const cn = document.getElementById('modal-cancel');
    function done(v) {
      m.hidden = true;
      ok.removeEventListener('click', okH);
      cn.removeEventListener('click', cnH);
      resolve(v);
    }
    function okH() { done(true); }
    function cnH() { done(false); }
    ok.addEventListener('click', okH);
    cn.addEventListener('click', cnH);
  });
}

// ============================================
// View routing
// ============================================
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  window.scrollTo(0, 0);
}

// ============================================
// HOME view
// ============================================
function getDeckCounts(catFilter) {
  const today = startOfDay();
  let due = 0, newq = 0;
  for (const q of state.questions) {
    if (catFilter !== 'all' && q.category !== catFilter) continue;
    const p = state.progress[q.id];
    if (!p || !p.due) {
      newq++;
    } else {
      const dueD = startOfDay(new Date(p.due));
      if (dueD <= today) due++;
    }
  }
  return { due, newq };
}

function getWrongCount(catFilter) {
  let n = 0;
  for (const q of state.questions) {
    if (catFilter !== 'all' && q.category !== catFilter) continue;
    const p = state.progress[q.id];
    if (!p) continue;
    if (p.lapses >= 1 && p.interval < 14) n++;
  }
  return n;
}

function renderHome() {
  // Category chips
  document.querySelectorAll('#view-home .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.cat === state.selectedCat);
  });
  // Counts
  const { due, newq } = getDeckCounts(state.selectedCat);
  document.getElementById('num-due').textContent = due;
  document.getElementById('num-new').textContent = newq;

  // Streak
  document.getElementById('num-streak').textContent = computeStreak();

  // Sub labels
  document.getElementById('btn-review-sub').textContent = `期日が来た問題 (${due}問)`;
  document.getElementById('btn-new-sub').textContent = `未学習の問題 (${newq}問)`;
  const wrongN = getWrongCount(state.selectedCat);
  document.getElementById('btn-wrong-sub').textContent = `直近で × にした問題 (${wrongN}問)`;

  // Cat stats line
  const cs = document.getElementById('cat-stats');
  if (state.selectedCat === 'all') {
    const lines = ['common','solution','engineering'].map(c => {
      const cnt = state.questions.filter(q => q.category === c).length;
      const dc = getDeckCounts(c);
      return `<span>${CATS[c]} ${cnt}問 (本日${dc.due+dc.newq})</span>`;
    });
    cs.innerHTML = lines.join('・');
  } else {
    cs.innerHTML = '';
  }

  // Exam countdown
  if (state.settings.examDate) {
    const d = daysBetween(new Date(), new Date(state.settings.examDate));
    const html = d > 0
      ? `試験まで <strong>${d}</strong> 日`
      : (d === 0 ? '<strong>本日が試験日です</strong>' : `試験日から ${-d} 日経過`);
    document.getElementById('exam-countdown').innerHTML = html;
  } else {
    document.getElementById('exam-countdown').textContent = '';
  }

  // Session size buttons
  document.querySelectorAll('.opt[data-size]').forEach(o => {
    o.classList.toggle('active', Number(o.dataset.size) === state.selectedSize);
  });
}

function computeStreak() {
  // Count consecutive days with at least 1 review, working backward from today.
  // Build set of dates from progress histories.
  const dates = new Set();
  for (const qid in state.progress) {
    for (const h of (state.progress[qid].history || [])) {
      if (h && h.d) dates.add(h.d);
    }
  }
  let streak = 0;
  let cur = startOfDay();
  // If today not present, streak starts from yesterday backwards.
  while (true) {
    const k = cur.toISOString().slice(0,10);
    if (dates.has(k)) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    } else if (streak === 0) {
      // allow today not to break streak -> roll back once
      cur.setDate(cur.getDate() - 1);
      const k2 = cur.toISOString().slice(0,10);
      if (dates.has(k2)) { streak++; cur.setDate(cur.getDate() - 1); }
      else break;
    } else {
      break;
    }
  }
  return streak;
}

// ============================================
// Build study decks
// ============================================
function buildDeck(mode) {
  const today = startOfDay();
  const cat = state.selectedCat;
  const size = state.selectedSize;
  const newCap = Math.max(0, state.settings.newPerDay - state.todaySeen.new);
  const revCap = Math.max(0, state.settings.revPerDay - state.todaySeen.rev);

  const filterCat = (q) => cat === 'all' || q.category === cat;

  const dueList = [];
  const newList = [];
  const wrongList = [];

  for (const q of state.questions) {
    if (!filterCat(q)) continue;
    const p = state.progress[q.id];
    if (!p || !p.due) {
      newList.push(q);
    } else {
      const dueD = startOfDay(new Date(p.due));
      if (dueD <= today) dueList.push(q);
      if (p.lapses >= 1 && p.interval < 14) wrongList.push(q);
    }
  }

  // Sort due by oldest due first (most overdue), then by importance desc
  dueList.sort((a, b) => {
    const da = new Date(state.progress[a.id].due);
    const db = new Date(state.progress[b.id].due);
    if (da - db !== 0) return da - db;
    return (b.importance || 3) - (a.importance || 3);
  });
  // Sort new by importance desc, then created
  newList.sort((a, b) => {
    const ai = (b.importance || 3) - (a.importance || 3);
    if (ai !== 0) return ai;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  wrongList.sort((a,b) => (state.progress[b.id].lapses || 0) - (state.progress[a.id].lapses || 0));

  let deck = [];
  if (mode === 'review') {
    deck = dueList.slice(0, revCap);
  } else if (mode === 'new') {
    deck = newList.slice(0, newCap);
  } else if (mode === 'wrong') {
    deck = wrongList; // no daily cap on revisiting wrongs
  } else if (mode === 'mixed') {
    // Interleave new + due according to mixRatio
    const [nr, rr] = state.settings.mixRatio.split(':').map(Number);
    const target = size > 0 ? size : (dueList.length + newList.length);
    const nN = Math.min(newList.length, newCap, Math.floor(target * nr / (nr + rr)));
    const rN = Math.min(dueList.length, revCap, target - nN);
    const news = newList.slice(0, nN);
    const revs = dueList.slice(0, rN);
    deck = interleave(revs, news);
  }
  if (size > 0 && deck.length > size) deck = deck.slice(0, size);
  return deck;
}

function interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  // light shuffle within blocks of 3 for variety
  for (let i = 0; i < out.length; i += 3) {
    const block = out.slice(i, i + 3);
    const sh = shuffle(block);
    for (let j = 0; j < block.length; j++) out[i + j] = sh[j];
  }
  return out;
}

// ============================================
// STUDY view
// ============================================
function startStudy(mode) {
  const deck = buildDeck(mode);
  if (deck.length === 0) {
    toast('対象の問題がありません');
    return;
  }
  state.studyDeck = deck;
  state.studyIdx = 0;
  state.studyStats = { again: 0, hard: 0, good: 0, easy: 0, total: 0, mode };
  renderStudy();
  showView('view-study');
  if (state.settings.ttsAuto) state.ttsEnabled = true;
}

function renderStudy() {
  const total = state.studyDeck.length;
  const idx = state.studyIdx;
  document.getElementById('progress-fill').style.width = `${(idx / total * 100)}%`;
  document.getElementById('progress-text').textContent = `${idx + 1} / ${total}`;

  const q = state.studyDeck[idx];
  const p = state.progress[q.id] || newProgress(q.id);

  // Meta
  const meta = [];
  meta.push(`<span class="meta-cat">${CATS[q.category] || q.category}</span>`);
  if (q.importance) {
    const stars = '★'.repeat(q.importance);
    meta.push(`<span class="meta-imp">${stars}</span>`);
  }
  if (q.source) meta.push(`<span>${escapeHtml(q.source)}</span>`);
  if (q.year) meta.push(`<span>(${q.year}年度)</span>`);
  if (q.author) meta.push(`<span class="meta-author">作:${escapeHtml(q.author)}</span>`);
  document.getElementById('study-meta').innerHTML = meta.join(' ');

  document.getElementById('study-question').innerHTML = renderBlanks(q.question);
  const ansEl = document.getElementById('study-answer');
  ansEl.innerHTML = renderAnswer(q.answer);
  ansEl.hidden = true;

  // Reset action area
  document.getElementById('btn-show-answer').hidden = false;
  document.getElementById('rating-grid').hidden = true;

  // TTS auto
  stopTTS();
  if (state.ttsEnabled) speakNow(q.question);

  // Update tts button state
  document.getElementById('btn-tts').textContent = state.ttsEnabled ? '🔇' : '🔊';
}

function showAnswer() {
  document.getElementById('study-answer').hidden = false;
  document.getElementById('btn-show-answer').hidden = true;

  // Show preview intervals on rating buttons
  const q = state.studyDeck[state.studyIdx];
  const p = JSON.parse(JSON.stringify(state.progress[q.id] || newProgress(q.id)));
  const ints = previewIntervals(p);
  document.getElementById('int-1').textContent = fmtDays(ints[0]);
  document.getElementById('int-2').textContent = fmtDays(ints[1]);
  document.getElementById('int-3').textContent = fmtDays(ints[2]);
  document.getElementById('int-4').textContent = fmtDays(ints[3]);
  document.getElementById('rating-grid').hidden = false;

  if (state.ttsEnabled) speakNow(q.answer);
}

async function rate(rating) {
  const q = state.studyDeck[state.studyIdx];
  let p = state.progress[q.id];
  const wasNew = !p || !p.due;
  if (!p) p = newProgress(q.id);
  p = applySM2(p, rating);
  state.progress[q.id] = p;
  await dbPut(STORE_P, p);

  // Counters
  if (wasNew) await bumpTodayCounter('new');
  else await bumpTodayCounter('rev');

  // Stats
  state.studyStats.total += 1;
  if (rating === 1) state.studyStats.again += 1;
  else if (rating === 2) state.studyStats.hard += 1;
  else if (rating === 3) state.studyStats.good += 1;
  else if (rating === 4) state.studyStats.easy += 1;

  // If rated Again, requeue near end of session for re-attempt
  if (rating === 1) {
    const requeuePos = Math.min(state.studyDeck.length, state.studyIdx + 4);
    state.studyDeck.splice(requeuePos, 0, q);
  }

  state.studyIdx += 1;
  if (state.studyIdx >= state.studyDeck.length) {
    finishStudy();
  } else {
    renderStudy();
  }
}

function finishStudy() {
  stopTTS();
  const s = state.studyStats;
  const acc = s.total ? Math.round(((s.good + s.easy) / s.total) * 100) : 0;
  document.getElementById('done-title').textContent = `${s.total}問完了!`;
  document.getElementById('done-stats').innerHTML =
    `正解率 <strong>${acc}%</strong><br>` +
    `<span style="color:var(--again)">●</span> もう一度 ${s.again}　` +
    `<span style="color:var(--hard)">●</span> 難 ${s.hard}<br>` +
    `<span style="color:var(--good)">●</span> 普通 ${s.good}　` +
    `<span style="color:var(--easy)">●</span> 簡単 ${s.easy}`;
  showView('view-done');
}

// ============================================
// TTS
// ============================================
function speakNow(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.0;
    state.utterance = u;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}
function stopTTS() {
  try { speechSynthesis.cancel(); } catch (e) {}
}
function toggleTTS() {
  state.ttsEnabled = !state.ttsEnabled;
  document.getElementById('btn-tts').textContent = state.ttsEnabled ? '🔇' : '🔊';
  if (state.ttsEnabled) {
    const q = state.studyDeck[state.studyIdx];
    const ansVisible = !document.getElementById('study-answer').hidden;
    speakNow(ansVisible ? q.answer : q.question);
  } else {
    stopTTS();
  }
}

// ============================================
// LIST view
// ============================================
function renderList() {
  // Counts
  document.getElementById('cnt-all').textContent = state.questions.length;
  for (const c of ['common','solution','engineering']) {
    document.getElementById('cnt-' + c).textContent =
      state.questions.filter(q => q.category === c).length;
  }
  document.querySelectorAll('#view-list .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.listcat === state.listCat);
  });

  let items = state.questions.slice();
  if (state.listCat !== 'all') items = items.filter(q => q.category === state.listCat);
  if (state.listStatus !== 'all') {
    items = items.filter(q => cardStatus(q, state.progress[q.id]) === state.listStatus);
  }
  if (state.listSearch) {
    const s = state.listSearch.toLowerCase();
    items = items.filter(q => {
      return (q.question || '').toLowerCase().includes(s)
          || (q.answer || '').toLowerCase().includes(s)
          || (q.source || '').toLowerCase().includes(s)
          || (q.tags || []).some(t => t.toLowerCase().includes(s));
    });
  }

  // Sort
  const sortFn = {
    created: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    importance: (a, b) => (b.importance || 0) - (a.importance || 0),
    due: (a, b) => {
      const pa = state.progress[a.id]; const pb = state.progress[b.id];
      const da = pa && pa.due ? new Date(pa.due).getTime() : Infinity;
      const db = pb && pb.due ? new Date(pb.due).getTime() : Infinity;
      return da - db;
    },
    lapses: (a, b) => {
      const la = (state.progress[a.id] || {}).lapses || 0;
      const lb = (state.progress[b.id] || {}).lapses || 0;
      return lb - la;
    },
  };
  items.sort(sortFn[state.listSort] || sortFn.created);

  const ul = document.getElementById('question-list');
  if (items.length === 0) {
    ul.innerHTML = '<li class="q-empty">該当する問題がありません<br>右上の「＋」から追加できます</li>';
    return;
  }
  ul.innerHTML = items.map(q => {
    const p = state.progress[q.id];
    const status = cardStatus(q, p);
    const statusLabel = {new:'未学習', learning:'学習中', review:'復習中', mastered:'習得', leech:'苦手'}[status];
    const stars = '★'.repeat(q.importance || 0);
    const due = p && p.due ? fmtDue(new Date(p.due)) : '未学習';
    const author = q.author ? `<span class="q-author">作:${escapeHtml(q.author)}</span>` : '';
    return `<li class="q-item" data-qid="${escapeHtml(q.id)}">
      <div class="q-item-head">
        <span class="q-cat-badge">${CATS[q.category] || q.category}</span>
        <span class="q-status q-status-${status}">${statusLabel}</span>
        <span class="q-importance">${stars}</span>
        ${author}
        <span style="margin-left:auto" class="q-due">${escapeHtml(due)}</span>
      </div>
      <div class="q-text">${escapeHtml(q.question)}</div>
    </li>`;
  }).join('');
  ul.querySelectorAll('.q-item').forEach(el => {
    el.addEventListener('click', () => openEditor(el.dataset.qid));
  });
}

// ============================================
// EDITOR view
// ============================================
function openEditor(qid) {
  state.editingId = qid;
  const q = qid ? state.questions.find(x => x.id === qid) : null;
  document.getElementById('edit-title').textContent = q ? '問題を編集' : '問題を追加';
  document.getElementById('btn-edit-delete').hidden = !q;
  state.editingCat = q ? q.category : 'common';
  state.editingImp = q ? (q.importance || 3) : 3;
  document.querySelectorAll('.seg-opt').forEach(s => {
    s.classList.toggle('active', s.dataset.edcat === state.editingCat);
  });
  document.querySelectorAll('#ed-stars .star').forEach(s => {
    s.classList.toggle('on', Number(s.dataset.imp) <= state.editingImp);
  });
  document.getElementById('ed-q').value = q ? q.question : '';
  document.getElementById('ed-a').value = q ? q.answer : '';
  document.getElementById('ed-tags').value = q ? (q.tags || []).join(', ') : '';
  document.getElementById('ed-source').value = q ? (q.source || '') : '';
  document.getElementById('ed-year').value = q && q.year ? String(q.year) : '';
  // For new questions, prefill author from settings; for existing, use stored
  document.getElementById('ed-author').value = q ? (q.author || '') : (state.settings.authorName || '');
  showView('view-edit');
}

async function saveEditor() {
  const qText = document.getElementById('ed-q').value.trim();
  const aText = document.getElementById('ed-a').value.trim();
  if (!qText || !aText) {
    toast('問題と解答は必須です');
    return;
  }
  const tagsRaw = document.getElementById('ed-tags').value;
  const tags = tagsRaw.split(/[,、]/).map(s => s.trim()).filter(Boolean);
  const source = document.getElementById('ed-source').value.trim();
  const yearV = document.getElementById('ed-year').value;
  const year = yearV ? Number(yearV) : null;
  const author = document.getElementById('ed-author').value.trim();

  let rec;
  if (state.editingId) {
    rec = state.questions.find(x => x.id === state.editingId);
    rec.category = state.editingCat;
    rec.question = qText;
    rec.answer = aText;
    rec.tags = tags;
    rec.source = source;
    rec.year = year;
    rec.importance = state.editingImp;
    rec.author = author || rec.author || '';
    rec.modifiedAt = new Date().toISOString();
  } else {
    rec = {
      id: uid(),
      category: state.editingCat,
      question: qText,
      answer: aText,
      tags, source, year,
      importance: state.editingImp,
      author: author || state.settings.authorName || '',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    };
    state.questions.push(rec);
  }
  await dbPut(STORE_Q, rec);
  toast(state.editingId ? '保存しました' : '追加しました');
  state.editingId = null;
  renderHome();
  renderList();
  showView('view-list');
}

async function deleteEditor() {
  if (!state.editingId) return;
  const ok = await confirm('この問題を削除します。\n進捗データも削除されます。よろしいですか?');
  if (!ok) return;
  await dbDel(STORE_Q, state.editingId);
  await dbDel(STORE_P, state.editingId);
  state.questions = state.questions.filter(q => q.id !== state.editingId);
  delete state.progress[state.editingId];
  state.editingId = null;
  toast('削除しました');
  renderHome();
  renderList();
  showView('view-list');
}

// ============================================
// STATS view
// ============================================
function renderStats() {
  let total = state.questions.length;
  let mastered = 0, review = 0, learning = 0, newq = 0, leech = 0;
  for (const q of state.questions) {
    const s = cardStatus(q, state.progress[q.id]);
    if (s === 'mastered') mastered++;
    else if (s === 'review') review++;
    else if (s === 'learning') learning++;
    else if (s === 'leech') leech++;
    else newq++;
  }
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-mastered').textContent = mastered;
  document.getElementById('stat-review').textContent = review;
  document.getElementById('stat-learning').textContent = learning;
  document.getElementById('stat-newq').textContent = newq;
  document.getElementById('stat-leech').textContent = leech;

  // Heatmap (last 30 days)
  const counts = {};
  for (const qid in state.progress) {
    for (const h of (state.progress[qid].history || [])) {
      counts[h.d] = (counts[h.d] || 0) + 1;
    }
  }
  const cells = [];
  const now = startOfDay();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    const n = counts[k] || 0;
    let lvl = 0;
    if (n >= 30) lvl = 4;
    else if (n >= 15) lvl = 3;
    else if (n >= 5) lvl = 2;
    else if (n >= 1) lvl = 1;
    cells.push(`<div class="heat-cell" data-level="${lvl}" title="${k}: ${n}回"></div>`);
  }
  document.getElementById('heatmap').innerHTML = cells.join('');

  // Cat progress
  const cp = document.getElementById('cat-progress');
  const html = ['common','solution','engineering'].map(c => {
    const qs = state.questions.filter(q => q.category === c);
    if (qs.length === 0) return `<div class="cat-prog-row">
      <div class="cat-prog-label"><span>${CATS[c]}</span><span>0問</span></div>
      <div class="cat-prog-bar"><div class="bar-new" style="width:100%"></div></div>
    </div>`;
    let mc=0, rc=0, lc=0, nc=0;
    for (const q of qs) {
      const s = cardStatus(q, state.progress[q.id]);
      if (s === 'mastered') mc++;
      else if (s === 'review') rc++;
      else if (s === 'learning' || s === 'leech') lc++;
      else nc++;
    }
    const t = qs.length;
    return `<div class="cat-prog-row">
      <div class="cat-prog-label"><span>${CATS[c]}</span><span>${mc}/${t} 習得</span></div>
      <div class="cat-prog-bar">
        <div class="bar-mastered" style="width:${mc/t*100}%"></div>
        <div class="bar-review" style="width:${rc/t*100}%"></div>
        <div class="bar-learning" style="width:${lc/t*100}%"></div>
        <div class="bar-new" style="width:${nc/t*100}%"></div>
      </div>
    </div>`;
  }).join('');
  cp.innerHTML = html;

  // Forecast
  if (state.settings.examDate) {
    const days = daysBetween(new Date(), new Date(state.settings.examDate));
    const remaining = total - mastered;
    const dailyCap = state.settings.newPerDay;
    const requiredPerDay = days > 0 ? Math.ceil(remaining / Math.max(days, 1)) : remaining;
    let msg = '';
    if (days <= 0) msg = '試験日を過ぎています。設定で日付を更新してください。';
    else if (remaining === 0) msg = `<strong>全${total}問が習得済み</strong>です。試験まで余裕があります(残り${days}日)。`;
    else {
      msg = `試験まで残り <strong>${days}</strong> 日<br>` +
            `未習得 <strong>${remaining}</strong> 問 / 1日上限 ${dailyCap}問<br>` +
            `1日あたり最低 <strong>${requiredPerDay}</strong> 問の新規消化が必要`;
      if (requiredPerDay > dailyCap) {
        msg += `<br><span style="color:var(--again)">⚠ 1日上限を超えています。設定で増やすか問題を絞り込みましょう。</span>`;
      }
    }
    document.getElementById('forecast').innerHTML = msg;
  } else {
    document.getElementById('forecast').textContent = '設定で試験日を入力すると、必要な学習ペースが表示されます。';
  }
}

// ============================================
// SETTINGS view
// ============================================
function renderSettings() {
  document.getElementById('set-exam-date').value = state.settings.examDate || '';
  document.getElementById('set-new-per-day').value = state.settings.newPerDay;
  document.getElementById('set-rev-per-day').value = state.settings.revPerDay;
  document.getElementById('set-mix-ratio').value = state.settings.mixRatio;
  document.getElementById('set-theme').value = state.settings.theme;
  document.getElementById('set-font-size').value = state.settings.fontSize;
  document.getElementById('set-tts-auto').checked = !!state.settings.ttsAuto;
  document.getElementById('set-author-name').value = state.settings.authorName || '';
}

async function saveSettingsFromForm() {
  state.settings.examDate = document.getElementById('set-exam-date').value;
  state.settings.newPerDay = Math.max(0, Number(document.getElementById('set-new-per-day').value) || 10);
  state.settings.revPerDay = Math.max(0, Number(document.getElementById('set-rev-per-day').value) || 100);
  state.settings.mixRatio = document.getElementById('set-mix-ratio').value;
  state.settings.theme = document.getElementById('set-theme').value;
  state.settings.fontSize = document.getElementById('set-font-size').value;
  state.settings.ttsAuto = document.getElementById('set-tts-auto').checked;
  state.settings.authorName = document.getElementById('set-author-name').value.trim();
  await saveSettings();
  applyTheme();
  applyFontSize();
}

// ============================================
// IMPORT / EXPORT
// ============================================
async function exportAll() {
  const data = {
    version: 2,
    type: 'full',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    questions: state.questions,
    progress: state.progress,
  };
  downloadJSON(data, `shoshin-shiken-full-${dateKey()}.json`);
  toast('全データをエクスポートしました');
}

async function exportQuestionsOnly() {
  const data = {
    version: 2,
    type: 'questions-only',
    exportedAt: new Date().toISOString(),
    note: '問題のみのエクスポート(進捗・設定は含まれません)。共有用。',
    questions: state.questions,
  };
  downloadJSON(data, `shoshin-shiken-questions-${dateKey()}.json`);
  toast(`${state.questions.length}問をエクスポートしました`);
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

async function importJSON(file, full) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.questions)) throw new Error('不正なファイル(questions配列なし)');

    // Type-aware safety check for full restore
    if (full && data.type === 'questions-only') {
      const ok = await confirm('このファイルは「問題のみ」です。完全復元すると、現在の進捗が消えてしまいます。\n本当に進めますか?');
      if (!ok) return;
    }

    let added = 0, updated = 0, skipped = 0;
    for (const q of data.questions) {
      if (!q.id) q.id = uid();
      if (!q.category) q.category = 'common';
      if (!q.createdAt) q.createdAt = new Date().toISOString();
      if (!q.modifiedAt) q.modifiedAt = q.createdAt;

      const existing = state.questions.find(x => x.id === q.id);
      if (existing) {
        // Merge: keep newer (modifiedAt-based); skip if local is newer/equal
        const localTime = new Date(existing.modifiedAt || existing.createdAt || 0).getTime();
        const importTime = new Date(q.modifiedAt || q.createdAt || 0).getTime();
        if (importTime > localTime || full) {
          const idx = state.questions.indexOf(existing);
          state.questions[idx] = q;
          await dbPut(STORE_Q, q);
          updated++;
        } else {
          skipped++;
        }
      } else {
        state.questions.push(q);
        await dbPut(STORE_Q, q);
        added++;
      }
    }

    if (full && data.progress) {
      // Replace progress
      await dbClear(STORE_P);
      state.progress = {};
      for (const k in data.progress) {
        const p = data.progress[k];
        await dbPut(STORE_P, p);
        state.progress[p.questionId] = p;
      }
    }
    if (full && data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      await saveSettings();
      applyTheme(); applyFontSize();
    }
    toast(`完了: 新規${added} / 更新${updated} / スキップ${skipped}`);
    renderHome(); renderList(); renderStats();
  } catch (e) {
    console.error(e);
    toast('インポート失敗: ' + e.message);
  }
}

async function importCSV(file) {
  // CSV format (header row required, tab or comma):
  //   必須: category, question, answer
  //   任意: tags, source, year, importance, author
  try {
    const text = await file.text();
    const sep = text.indexOf('\t') >= 0 && text.indexOf('\t') < text.indexOf('\n') ? '\t' : ',';
    const rows = parseDelim(text, sep);
    if (rows.length < 2) throw new Error('行が足りません');
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const idx = (name) => headers.indexOf(name);
    const iCat = idx('category'); const iQ = idx('question'); const iA = idx('answer');
    const iTags = idx('tags'); const iSrc = idx('source'); const iYear = idx('year');
    const iImp = idx('importance'); const iAuth = idx('author');
    if (iQ < 0 || iA < 0) throw new Error('question / answer 列が必須です');
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[iQ] || !r[iA]) continue;
      const cat = (iCat >= 0 ? r[iCat] : 'common').trim().toLowerCase();
      const catNorm = ['common','solution','engineering'].includes(cat) ? cat
        : (cat.includes('共') ? 'common' : (cat.includes('ソリュ') ? 'solution' : (cat.includes('エンジ') ? 'engineering' : 'common')));
      const q = {
        id: uid(),
        category: catNorm,
        question: r[iQ].trim(),
        answer: r[iA].trim(),
        tags: iTags >= 0 ? (r[iTags] || '').split(/[,、|;]/).map(s => s.trim()).filter(Boolean) : [],
        source: iSrc >= 0 ? (r[iSrc] || '').trim() : '',
        year: iYear >= 0 && r[iYear] ? Number(r[iYear].trim()) : null,
        importance: iImp >= 0 && r[iImp] ? Math.max(1, Math.min(5, Number(r[iImp]))) : 3,
        author: iAuth >= 0 ? (r[iAuth] || '').trim() : (state.settings.authorName || ''),
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      };
      state.questions.push(q);
      await dbPut(STORE_Q, q);
      n++;
    }
    toast(`CSVから ${n} 件取り込みました`);
    renderHome(); renderList(); renderStats();
  } catch (e) {
    console.error(e);
    toast('CSV取り込み失敗: ' + e.message);
  }
}

function parseDelim(text, sep) {
  // Minimal CSV parser supporting quoted fields with newlines
  const out = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* ignore */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

async function resetProgress() {
  await dbClear(STORE_P);
  state.progress = {};
  await metaSet('todayCounters', { date: state.todayKey, new: 0, rev: 0 });
  state.todaySeen = { new: 0, rev: 0 };
  toast('進捗をリセットしました');
  renderHome(); renderList(); renderStats();
}

async function resetAll() {
  await dbClear(STORE_Q);
  await dbClear(STORE_P);
  await dbClear(STORE_S);
  await dbClear(STORE_M);
  state.questions = [];
  state.progress = {};
  state.settings = {
    examDate: '2026-08-31', newPerDay: 10, revPerDay: 100,
    mixRatio: '3:7', theme: 'auto', fontSize: 'm', ttsAuto: false,
  };
  await saveSettings();
  state.todaySeen = { new: 0, rev: 0 };
  toast('全データを削除しました');
  await loadSeed(false);
  applyTheme(); applyFontSize();
  renderHome(); renderList(); renderStats(); renderSettings();
}

// ============================================
// EVENTS
// ============================================
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      const v = t.dataset.view;
      showView(v);
      if (v === 'view-home') renderHome();
      if (v === 'view-list') renderList();
      if (v === 'view-stats') renderStats();
    });
  });

  // Home: category chips
  document.querySelectorAll('#view-home .chip').forEach(c => {
    c.addEventListener('click', () => {
      state.selectedCat = c.dataset.cat;
      renderHome();
    });
  });
  // Session size
  document.querySelectorAll('.opt[data-size]').forEach(o => {
    o.addEventListener('click', () => {
      state.selectedSize = Number(o.dataset.size);
      renderHome();
    });
  });
  // Action buttons
  document.getElementById('btn-review').addEventListener('click', () => startStudy('review'));
  document.getElementById('btn-new').addEventListener('click', () => startStudy('new'));
  document.getElementById('btn-mixed').addEventListener('click', () => startStudy('mixed'));
  document.getElementById('btn-wrong').addEventListener('click', () => startStudy('wrong'));

  // Settings open/close
  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettings();
    showView('view-settings');
  });
  document.getElementById('btn-settings-back').addEventListener('click', async () => {
    await saveSettingsFromForm();
    showView('view-home'); renderHome();
  });

  // Settings: live save fields
  ['set-exam-date','set-new-per-day','set-rev-per-day','set-mix-ratio',
   'set-theme','set-font-size','set-tts-auto','set-author-name'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromForm);
  });

  // Study controls
  document.getElementById('btn-show-answer').addEventListener('click', showAnswer);
  document.querySelectorAll('.rate').forEach(r => {
    r.addEventListener('click', () => rate(Number(r.dataset.rating)));
  });
  document.getElementById('btn-study-back').addEventListener('click', async () => {
    if (state.studyIdx > 0) {
      const ok = await confirm('セッションを中断します。\n途中の進捗は保存されています。');
      if (!ok) return;
    }
    stopTTS();
    showView('view-home'); renderHome();
  });
  document.getElementById('btn-tts').addEventListener('click', toggleTTS);

  // Done
  document.getElementById('btn-done-home').addEventListener('click', () => { showView('view-home'); renderHome(); });
  document.getElementById('btn-done-again').addEventListener('click', () => {
    const mode = state.studyStats.mode || 'mixed';
    startStudy(mode);
  });

  // List
  document.getElementById('btn-add').addEventListener('click', () => openEditor(null));
  document.querySelectorAll('#view-list .chip').forEach(c => {
    c.addEventListener('click', () => {
      state.listCat = c.dataset.listcat;
      renderList();
    });
  });
  document.getElementById('list-status').addEventListener('change', (e) => {
    state.listStatus = e.target.value; renderList();
  });
  document.getElementById('list-sort').addEventListener('change', (e) => {
    state.listSort = e.target.value; renderList();
  });
  document.getElementById('list-search').addEventListener('input', (e) => {
    state.listSearch = e.target.value.trim();
    renderList();
  });

  // Editor
  document.getElementById('btn-edit-back').addEventListener('click', () => {
    state.editingId = null;
    showView('view-list');
  });
  document.getElementById('btn-edit-save').addEventListener('click', saveEditor);
  document.getElementById('btn-edit-delete').addEventListener('click', deleteEditor);
  document.querySelectorAll('.seg-opt').forEach(s => {
    s.addEventListener('click', () => {
      state.editingCat = s.dataset.edcat;
      document.querySelectorAll('.seg-opt').forEach(x => x.classList.toggle('active', x === s));
    });
  });
  document.querySelectorAll('#ed-stars .star').forEach(s => {
    s.addEventListener('click', () => {
      state.editingImp = Number(s.dataset.imp);
      document.querySelectorAll('#ed-stars .star').forEach(x => {
        x.classList.toggle('on', Number(x.dataset.imp) <= state.editingImp);
      });
    });
  });

  // Settings: import/export
  document.getElementById('btn-export-all').addEventListener('click', exportAll);
  document.getElementById('btn-export-questions').addEventListener('click', exportQuestionsOnly);
  document.getElementById('btn-import-questions').addEventListener('click', () => {
    document.getElementById('file-import').dataset.full = '0';
    document.getElementById('file-import').click();
  });
  document.getElementById('btn-import-full').addEventListener('click', () => {
    document.getElementById('file-import').dataset.full = '1';
    document.getElementById('file-import').click();
  });
  document.getElementById('file-import').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const full = e.target.dataset.full === '1';
    if (full) {
      const ok = await confirm('既存の進捗を削除して、JSONの内容で完全復元します。\nよろしいですか?');
      if (!ok) { e.target.value = ''; return; }
    }
    await importJSON(f, full);
    e.target.value = '';
  });
  document.getElementById('btn-import-csv').addEventListener('click', () => {
    document.getElementById('file-import-csv').click();
  });
  document.getElementById('file-import-csv').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await importCSV(f);
    e.target.value = '';
  });
  document.getElementById('btn-load-seed').addEventListener('click', () => loadSeed(true).then(() => {
    renderHome(); renderList(); renderStats();
  }));

  // Settings: reset
  document.getElementById('btn-reset-progress').addEventListener('click', async () => {
    const ok = await confirm('全ての学習進捗(SM-2の状態・履歴・本日のカウンタ)をリセットします。\n問題自体は残ります。よろしいですか?');
    if (!ok) return;
    await resetProgress();
  });
  document.getElementById('btn-reset-all').addEventListener('click', async () => {
    const ok = await confirm('全データを削除し、シード問題を再読込します。\n本当によろしいですか?');
    if (!ok) return;
    await resetAll();
  });

  // Modal close on backdrop click
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') {
      document.getElementById('modal-cancel').click();
    }
  });

  // Prefer no double-tap zoom on iOS
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

// Boot
window.addEventListener('DOMContentLoaded', init);

})();
