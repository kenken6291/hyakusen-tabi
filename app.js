/* 百選たびノート app.js */
(() => {
'use strict';
const C = window.APP_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('hyakusen_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hyakusen_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('hyakusen_' + k); } catch {} }
};
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];

const state = {
  token: LS.get('token', ''),
  user: LS.get('user', null),
  categories: [], spots: [],
  filter: { cat: '', pref: '', kw: '' },
  plan: LS.get('draft', null) || newPlan(),
  plans: [],
  guideSpot: null, guideData: null
};

function newPlan() {
  return { planId: '', title: '', date: '', start: '09:00', mode: 'car', memo: '', items: [] };
}

/* ---------- 共通 ---------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(action, data = {}, { auth = false } = {}) {
  if (auth && !state.token) { openAuth('login'); throw new Error('ログインが必要です'); }
  const res = await fetch(C.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // CORSプリフライト回避
    body: JSON.stringify({ action, data, token: state.token })
  });
  const json = await res.json();
  if (!json.ok) {
    if (json.code === 'AUTH') { clearSession(); openAuth('login'); }
    if (json.code === 'MUST_CHANGE') openChange(true);
    throw new Error(json.error || 'エラーが発生しました');
  }
  return json;
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || '処理中…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const hasPos = s => s && isFinite(+s.lat) && isFinite(+s.lng) && +s.lat !== 0;

/* =========================================================
   音声入力：言葉の間で途切れない認識
   - continuous=true / interimResults=true
   - ブラウザが勝手に onend しても、利用者が止めるまで自動再開
   - 確定文はセッションをまたいで保持（再開で消えない）
   - 最後の発話から silenceMs 無音で自動確定（デバウンス）
   - Android Chromeの「確定文が累積で重複する」癖を補正
   ========================================================= */
class SteadyRecognizer {
  constructor({ onText, onState }) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.onText = onText; this.onState = onState;
    this.active = false; this.committed = ''; this.rec = null;
  }
  get supported() { return !!this.SR; }
  start() {
    if (!this.supported) { toast('このブラウザは音声入力に対応していません（Chrome・Edge・Safariをお使いください）'); return; }
    this.active = true; this.committed = ''; this.heard = false;
    this._armSilence(C.SPEECH.firstWaitMs);
    this._begin(); this.onState('listening');
  }
  _begin() {
    const r = new this.SR();
    r.lang = C.SPEECH.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    let sessionFinal = '';
    r.onresult = e => {
      let finals = [], interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          const prev = finals[finals.length - 1];
          if (prev && t.startsWith(prev)) finals[finals.length - 1] = t; // Android重複補正
          else finals.push(t);
        } else interim += t;
      }
      sessionFinal = finals.join('');
      this._session = sessionFinal;
      this.heard = true;
      this._armSilence(C.SPEECH.silenceMs);
      this.onText((this.committed + sessionFinal + interim).trim(), false);
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('マイクの使用が許可されていません。ブラウザの設定で許可してください。');
        this.stop(true);
      }
      // no-speech / aborted / network は onend で再開
    };
    r.onend = () => {
      this.committed += this._session || ''; this._session = '';
      if (this.active) setTimeout(() => this.active && this._begin(), C.SPEECH.restartDelayMs);
    };
    this.rec = r;
    try { r.start(); } catch { /* 既に開始済み */ }
  }
  _armSilence(ms) {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.stop(), ms);
  }
  stop(silent) {
    if (!this.active) return;
    this.active = false; clearTimeout(this.silenceTimer);
    try { this.rec && this.rec.stop(); } catch {}
    const text = (this.committed + (this._session || '')).trim();
    this.onState('idle');
    if (!silent) this.onText(text, true);
  }
}

let currentMic = null;
function setupMics() {
  $$('.mic').forEach(btn => {
    const target = $('#' + btn.dataset.micTarget);
    let base = '';
    const rec = new SteadyRecognizer({
      onText: (text, done) => {
        target.value = (base ? base + (target.tagName === 'TEXTAREA' ? '\n' : ' ') : '') + text;
        target.dispatchEvent(new Event('input'));
        $('#micLog').textContent = done ? '' : '聞き取り中…（話し終えて少し待つと自動で止まります）';
      },
      onState: s => {
        btn.classList.toggle('on', s === 'listening');
        btn.setAttribute('aria-label', s === 'listening' ? '音声入力を止める' : '音声で入力');
        if (s !== 'listening') { $('#micLog').textContent = ''; if (currentMic === rec) currentMic = null; }
      }
    });
    btn.addEventListener('click', () => {
      if (rec.active) { rec.stop(); return; }
      if (currentMic) currentMic.stop();
      base = target.value.trim(); currentMic = rec; rec.start();
    });
  });
}

/* =========================================================
   認証
   ========================================================= */
function setSession(token, user) {
  state.token = token; state.user = user;
  LS.set('token', token); LS.set('user', user); renderAccount();
}
function clearSession() {
  state.token = ''; state.user = null; LS.del('token'); LS.del('user'); renderAccount();
}
function renderAccount() {
  $('#btnAccount').textContent = state.user ? `${state.user.nickname} さん` : 'ログイン';
}
function openAuth(pane = 'login') {
  const d = $('#dlgAuth');
  const logged = !!state.user;
  $('.segment', d).hidden = logged;
  $$('[data-pane]', d).forEach(f => f.hidden = logged || f.dataset.pane !== pane);
  $$('[data-auth]', d).forEach(b => b.setAttribute('aria-selected', b.dataset.auth === pane));
  $('#accountPane').hidden = !logged;
  $('#authTitle').textContent = logged ? 'アカウント' : ({ login: 'ログイン', register: '新規登録', forgot: 'パスワード再発行' })[pane];
  if (logged) $('#accountInfo').textContent = `${state.user.nickname} さん（${state.user.email}）でログイン中です。`;
  $$('[data-err]', d).forEach(e => e.textContent = '');
  if (!d.open) d.showModal();
}
function openChange(force) {
  const d = $('#dlgChange');
  d.dataset.force = force ? '1' : '';
  $('#chgClose').hidden = !!force;
  $('#chgLead').hidden = !force;
  $('#formChange').reset(); $('[data-err]', d).textContent = '';
  if (!d.open) d.showModal();
}

function setupAuth() {
  $('#btnAccount').onclick = () => openAuth('login');
  $$('[data-auth]').forEach(b => b.onclick = () => openAuth(b.dataset.auth));
  // 目アイコン（表示/非表示）
  $$('.pw .eye').forEach(b => b.onclick = () => {
    const i = b.previousElementSibling, show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    b.textContent = show ? '🙈' : '👁';
    b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
  });
  // 初回変更は Esc で閉じさせない
  $('#dlgChange').addEventListener('cancel', e => { if ($('#dlgChange').dataset.force) e.preventDefault(); });

  $('#formLogin').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f), btn = $('button[type=submit]', f);
    busy(btn, true, 'ログイン中…'); err.textContent = '';
    try {
      const r = await api('login', { email: $('#liEmail').value.trim(), password: $('#liPw').value });
      setSession(r.token, r.user);
      $('#dlgAuth').close(); f.reset();
      if (r.isFirstLogin) openChange(true);
      else { toast('ログインしました'); loadPlans(); }
    } catch (ex) { err.textContent = ex.message; }
    busy(btn, false);
  };
  $('#formRegister').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f), btn = $('button[type=submit]', f);
    busy(btn, true, '送信中…'); err.textContent = '';
    try {
      const r = await api('register', { email: $('#rgEmail').value.trim(), nickname: $('#rgNick').value.trim() });
      toast(r.message, 5000); f.reset(); openAuth('login');
    } catch (ex) { err.textContent = ex.message; }
    busy(btn, false);
  };
  $('#formForgot').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f), btn = $('button[type=submit]', f);
    busy(btn, true, '送信中…'); err.textContent = '';
    try {
      const r = await api('forgotPassword', { email: $('#fgEmail').value.trim() });
      toast(r.message, 5000); f.reset(); openAuth('login');
    } catch (ex) { err.textContent = ex.message; }
    busy(btn, false);
  };
  $('#formChange').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f), btn = $('button[type=submit]', f);
    const cur = $('#chCur').value, nw = $('#chNew').value, nw2 = $('#chNew2').value;
    if (nw !== nw2) { err.textContent = '確認用のパスワードが一致しません'; return; }
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(nw)) { err.textContent = '8文字以上で、英字と数字を両方含めてください'; return; }
    busy(btn, true, '変更中…'); err.textContent = '';
    try {
      await api('changePassword', { currentPassword: cur, newPassword: nw }, { auth: true });
      const d = $('#dlgChange'); d.dataset.force = ''; d.close();
      toast('パスワードを変更しました'); loadPlans();
    } catch (ex) { err.textContent = ex.message; }
    busy(btn, false);
  };
  $('#btnOpenChange').onclick = () => { $('#dlgAuth').close(); openChange(false); };
  $('#btnLogout').onclick = async () => {
    try { await api('logout', {}); } catch {}
    clearSession(); state.plans = []; renderPlanList(); $('#dlgAuth').close(); toast('ログアウトしました');
  };
}

/* =========================================================
   百選データ・検索
   ========================================================= */
let mapSearch, layerSearch, mapPlan, layerPlan;
function initMaps() {
  const tiles = () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' });
  mapSearch = L.map('mapSearch').setView(C.MAP.center, C.MAP.zoom); tiles().addTo(mapSearch);
  layerSearch = L.layerGroup().addTo(mapSearch);
  mapPlan = L.map('mapPlan').setView(C.MAP.center, C.MAP.zoom); tiles().addTo(mapPlan);
  layerPlan = L.layerGroup().addTo(mapPlan);
}

async function loadMaster() {
  const cached = LS.get('master', null);
  if (cached) applyMaster(cached);
  try {
    const r = await api('getMaster');
    LS.set('master', { categories: r.categories, spots: r.spots });
    applyMaster(r);
  } catch (e) { if (!cached) toast('データを読み込めませんでした：' + e.message, 5000); }
}
function applyMaster(m) {
  state.categories = m.categories || [];
  state.spots = (m.spots || []).map(s => ({ ...s, lat: +s.lat, lng: +s.lng }));
  renderChips(); renderSpots();
}
const catOf = id => state.categories.find(c => c.categoryId === id) || { name: id, icon: '📍' };

function renderChips() {
  const mk = c => `<button class="chip" type="button" data-cat="${esc(c.categoryId)}" aria-pressed="${state.filter.cat === c.categoryId}">${esc(c.icon || '')} ${esc(c.name)}</button>`;
  const all = `<button class="chip" type="button" data-cat="" aria-pressed="${!state.filter.cat}">すべて</button>`;
  $('#chipsMain').innerHTML = all + state.categories.filter(c => c.group === 'main').map(mk).join('');
  $('#chipsOther').innerHTML = state.categories.filter(c => c.group !== 'main').map(mk).join('');
  $$('.chip').forEach(b => b.onclick = () => { state.filter.cat = b.dataset.cat; renderChips(); renderSpots(); });
}

function filteredSpots() {
  const { cat, pref, kw } = state.filter;
  const k = kw.trim().toLowerCase();
  return state.spots.filter(s =>
    (!cat || s.category === cat) && (!pref || String(s.pref).split(/[・、,\s]+/).includes(pref)) &&
    (!k || (s.name + s.description + s.pref).toLowerCase().includes(k)));
}

function renderSpots() {
  const list = filteredSpots();
  $('#resultCount').textContent = `${list.length} 件`;
  $('#spotList').innerHTML = list.length ? list.slice(0, 200).map(s => {
    const c = catOf(s.category);
    const info = [s.pref, s.elevation ? `標高${s.elevation}` : '', s.distanceKm ? `約${s.distanceKm}km` : '', s.durationMin ? `目安${s.durationMin}分` : '', s.difficulty].filter(Boolean).join('　');
    return `<li class="spot">
      <div class="meta"><span class="cat">${esc(c.icon)} ${esc(c.name)}</span>　${esc(info)}${String(s.sample).toUpperCase() === 'TRUE' ? '<span class="sample">サンプル</span>' : ''}</div>
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.description)}</p>
      <div class="acts">
        <button class="btn small primary" type="button" data-add="${esc(s.spotId)}">計画に追加</button>
        <button class="btn small" type="button" data-guide="${esc(s.spotId)}">案内を見る</button>
        ${hasPos(s) ? `<button class="btn small ghost" type="button" data-fly="${esc(s.spotId)}">地図で見る</button>` : ''}
      </div></li>`;
  }).join('') : '<li class="empty">条件に合うスポットがありません。分野や都道府県を変えてみてください。</li>';

  layerSearch.clearLayers();
  const pts = [];
  list.filter(hasPos).forEach(s => {
    L.marker([s.lat, s.lng]).bindPopup(`<b>${esc(s.name)}</b><br>${esc(catOf(s.category).name)}`).addTo(layerSearch);
    pts.push([s.lat, s.lng]);
  });
  if (pts.length) mapSearch.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
}

function setupSearch() {
  $('#selPref').innerHTML += PREFS.map(p => `<option>${p}</option>`).join('');
  $('#selPref').onchange = e => { state.filter.pref = e.target.value; renderSpots(); };
  let t; $('#txtKeyword').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.filter.kw = e.target.value; renderSpots(); }, 250); });
  $('#spotList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.add) addSpotToPlan(b.dataset.add);
    if (b.dataset.guide) openGuide(b.dataset.guide);
    if (b.dataset.fly) { const s = state.spots.find(x => x.spotId === b.dataset.fly); mapSearch.setView([s.lat, s.lng], 13); mapSearch.getContainer().scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
}

/* =========================================================
   計画（行程表）
   ========================================================= */
function saveDraft() { LS.set('draft', state.plan); }
function addSpotToPlan(spotId) {
  const s = state.spots.find(x => x.spotId === spotId); if (!s) return;
  state.plan.items.push({ type: 'spot', spotId, name: s.name, lat: s.lat, lng: s.lng, stay: +s.durationMin || 60, note: '' });
  saveDraft(); renderPlan(); toast(`「${s.name}」を計画に追加しました`);
}
function travelMin(a, b) {
  if (!hasPos(a) || !hasPos(b)) return 0;
  const d = km(a, b) * 1.3; // 直線距離→道のりの目安
  const mode = state.plan.mode;
  const kmh = mode === 'walk' ? C.MAP.walkKmh : mode === 'bike' ? C.MAP.bikeKmh : C.MAP.carKmh;
  return Math.round(d / kmh * 60);
}
const toMin = hm => { const [h, m] = (hm || '09:00').split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function renderPlan() {
  const p = state.plan;
  $('#planTitle').value = p.title; $('#planDate').value = p.date; $('#planStart').value = p.start;
  $('#planMode').value = p.mode; $('#planMemo').value = p.memo;
  let t = toMin(p.start);
  const html = p.items.map((it, i) => {
    let move = '';
    if (i > 0) {
      const mv = travelMin(p.items[i - 1], it);
      t += mv;
      move = mv ? `<li class="move">移動 約${mv}分（直線距離からの目安）</li>` : '';
    }
    const arrive = t; t += (+it.stay || 0);
    return `${move}<li class="stop">
      <div class="t">${toHM(arrive)}</div><div class="dot"></div>
      <div class="body">
        <h4>${esc(it.name)}</h4>
        <div class="row">
          <label>滞在 <input type="number" min="0" step="10" value="${esc(it.stay)}" data-stay="${i}" aria-label="${esc(it.name)}の滞在時間（分）"> 分</label>
          <button class="btn small ghost" type="button" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="前へ">▲</button>
          <button class="btn small ghost" type="button" data-down="${i}" ${i === p.items.length - 1 ? 'disabled' : ''} aria-label="後へ">▼</button>
          ${it.type === 'spot' ? `<button class="btn small" type="button" data-gd="${esc(it.spotId)}">案内を見る</button>` : ''}
          <button class="btn small danger" type="button" data-rm="${i}">外す</button>
        </div>
      </div></li>`;
  }).join('');
  $('#stopList').innerHTML = p.items.length
    ? html + `<li class="move">帰着の目安 ${toHM(t)}</li>`
    : '<li class="empty">「さがす」でスポットの「計画に追加」を押すと、ここに行程が並びます。</li>';

  layerPlan.clearLayers();
  const pts = p.items.filter(hasPos).map(x => [+x.lat, +x.lng]);
  p.items.filter(hasPos).forEach((x, i) => L.marker([+x.lat, +x.lng]).bindTooltip(`${i + 1}. ${x.name}`, { permanent: false }).addTo(layerPlan));
  if (pts.length > 1) L.polyline(pts, { color: '#2B4F7A', weight: 4, dashArray: '6 6' }).addTo(layerPlan);
  if (pts.length) mapPlan.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
}

function setupPlan() {
  const bind = (id, key) => $(id).addEventListener('input', e => { state.plan[key] = e.target.value; saveDraft(); if (key === 'start' || key === 'mode') renderPlan(); });
  bind('#planTitle', 'title'); bind('#planDate', 'date'); bind('#planStart', 'start'); bind('#planMemo', 'memo');
  $('#planMode').onchange = e => { state.plan.mode = e.target.value; saveDraft(); renderPlan(); };
  $('#stopList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const items = state.plan.items, d = b.dataset;
    if (d.up) { const i = +d.up; [items[i - 1], items[i]] = [items[i], items[i - 1]]; }
    else if (d.down) { const i = +d.down; [items[i + 1], items[i]] = [items[i], items[i + 1]]; }
    else if (d.rm) items.splice(+d.rm, 1);
    else if (d.gd) return openGuide(d.gd);
    saveDraft(); renderPlan();
  });
  $('#stopList').addEventListener('change', e => {
    if (e.target.dataset.stay) { state.plan.items[+e.target.dataset.stay].stay = Math.max(0, +e.target.value || 0); saveDraft(); renderPlan(); }
  });
  $('#btnAddCustom').onclick = () => {
    const v = $('#customStop').value.trim(); if (!v) return;
    state.plan.items.push({ type: 'custom', name: v, stay: 30, note: '' });
    $('#customStop').value = ''; saveDraft(); renderPlan();
  };
  $('#btnNewPlan').onclick = () => {
    if (state.plan.items.length && !confirm('いまの計画を閉じて、新しい計画を始めますか？（保存していない変更は消えます）')) return;
    state.plan = newPlan(); saveDraft(); renderPlan(); $('#adviceBox').innerHTML = '';
  };
  $('#btnSavePlan').onclick = async e => {
    if (!state.plan.title.trim()) { toast('計画の名前を入れてください'); $('#planTitle').focus(); return; }
    busy(e.target, true, '保存中…');
    try {
      const r = await api('savePlan', { plan: state.plan }, { auth: true });
      state.plan.planId = r.planId; saveDraft(); toast('計画を保存しました'); loadPlans();
    } catch (ex) { toast(ex.message, 4000); }
    busy(e.target, false);
  };
  $('#btnRoute').onclick = () => {
    const stops = state.plan.items.filter(hasPos);
    if (!stops.length) { toast('地図上の場所がある行程がありません'); return; }
    const ll = s => `${s.lat},${s.lng}`;
    const dest = stops[stops.length - 1];
    const way = stops.slice(0, -1).slice(0, 9).map(ll).join('|');
    const mode = { car: 'driving', walk: 'walking', bike: 'bicycling', transit: 'transit' }[state.plan.mode];
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ll(dest))}` +
      (way && mode !== 'transit' ? `&waypoints=${encodeURIComponent(way)}` : '') + `&travelmode=${mode}`;
    window.open(url, '_blank', 'noopener');
  };
  $('#btnAdvice').onclick = async e => {
    if (!state.plan.items.length) { toast('行程を1つ以上入れてください'); return; }
    busy(e.target, true, 'AIが確認中…');
    try {
      const r = await api('planAdvice', { plan: state.plan }, { auth: true });
      $('#adviceBox').innerHTML = `<div class="advice">${esc(r.text)}</div>`;
    } catch (ex) { toast(ex.message, 4000); }
    busy(e.target, false);
  };
}

/* ---------- マイ計画 ---------- */
async function loadPlans() {
  if (!state.token) { renderPlanList(); return; }
  try { const r = await api('listPlans', {}, { auth: true }); state.plans = r.plans; } catch { state.plans = []; }
  renderPlanList();
}
function renderPlanList() {
  const ul = $('#planList');
  if (!state.user) { ul.innerHTML = '<li class="empty">計画の保存・呼び出しにはログインが必要です。<button class="btn small primary" type="button" data-login>ログイン・新規登録</button></li>'; return; }
  ul.innerHTML = state.plans.length ? state.plans.map(p => `<li>
    <div><strong>${esc(p.title)}</strong><br><span class="spot meta">${esc(p.date || '日付未定')}　${p.items.length}か所</span></div>
    <div class="acts" style="display:flex;gap:6px">
      <button class="btn small primary" type="button" data-open="${esc(p.planId)}">開く</button>
      <button class="btn small danger" type="button" data-del="${esc(p.planId)}">削除</button>
    </div></li>`).join('')
    : '<li class="empty">まだ保存した計画はありません。「計画」で行程を作って保存しましょう。</li>';
}
function setupMine() {
  $('#planList').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.login !== undefined) return openAuth('login');
    if (b.dataset.open) {
      const p = state.plans.find(x => x.planId === b.dataset.open);
      state.plan = JSON.parse(JSON.stringify(p)); saveDraft(); renderPlan(); showView('plan');
    }
    if (b.dataset.del) {
      if (!confirm('この計画を削除しますか？')) return;
      try { await api('deletePlan', { planId: b.dataset.del }, { auth: true }); toast('削除しました'); loadPlans(); }
      catch (ex) { toast(ex.message); }
    }
  });
}

/* =========================================================
   案内（Gemini 解説 + Gemini TTS）
   ========================================================= */
function openGuide(spotId) {
  const s = state.spots.find(x => x.spotId === spotId); if (!s) return;
  stopAudio();
  state.guideSpot = s; state.guideData = null;
  $('#guideEmpty').hidden = true; $('#guideBody').hidden = false;
  const c = catOf(s.category);
  $('#guideMeta').innerHTML = `<span class="cat">${esc(c.icon)} ${esc(c.name)}</span>　${esc(s.pref)}`;
  $('#h-guide').textContent = s.name;
  $('#guideVideo').innerHTML = s.videoFileId
    ? `<iframe class="video" src="https://drive.google.com/file/d/${encodeURIComponent(s.videoFileId)}/preview" allow="autoplay; fullscreen" allowfullscreen title="${esc(s.name)} の紹介動画"></iframe>`
    : `<div class="novideo">このスポットの紹介動画はまだありません。<br>Google Earth Studioで作った動画をDriveに置き、スプレッドシートに登録すると表示されます。</div>`;
  $('#guideContent').innerHTML = `<div class="gsec"><p>${esc(s.description)}</p></div>`;
  $('#hereInfo').textContent = '';
  $('#btnPlay').disabled = true; $('#playStatus').textContent = '';
  showView('guide');
}

function renderGuide(g) {
  const list = arr => (arr || []).map(x => `<li>${esc(x)}</li>`).join('');
  $('#guideContent').innerHTML = `
    <div class="gsec"><h3>歴史・成り立ち</h3><p>${esc(g.history)}</p></div>
    <div class="gsec"><h3>見どころ</h3><ul>${list(g.highlights)}</ul></div>
    <div class="gsec"><h3>おすすめの季節</h3><p>${esc(g.bestSeason)}</p></div>
    <div class="gsec caution"><h3>安全上の注意</h3><ul>${list(g.cautions)}</ul></div>
    <div class="gsec"><h3>音声ガイドの原稿</h3><p>${esc(g.narration)}</p></div>
    <p class="hint">AIによる解説です。開門時間・通行止め・天候などは公式情報で確認してください。</p>`;
}

/* --- 音声再生キュー：句点で分割→順に合成→先読みしながら再生 --- */
const audio = new Audio();
let playToken = 0;
function splitNarration(text, max) {
  const sents = text.replace(/\s+/g, ' ').split(/(?<=[。！？])/).filter(s => s.trim());
  const out = []; let buf = '';
  for (const s of sents) {
    if ((buf + s).length > max && buf) { out.push(buf); buf = ''; }
    buf += s;
  }
  if (buf.trim()) out.push(buf);
  return out;
}
async function ttsChunk(text) {
  const r = await api('tts', { text, voice: C.TTS.voice }, { auth: true });
  return 'data:audio/wav;base64,' + r.audio;
}
async function playNarration() {
  if (!state.guideData) return;
  const my = ++playToken;
  const chunks = splitNarration(state.guideData.narration, C.TTS.chunkChars);
  $('#btnStop').disabled = false; $('#btnPlay').disabled = true;
  try {
    let next = ttsChunk(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      $('#playStatus').textContent = `音声を準備中…（${i + 1}/${chunks.length}）`;
      const src = await next;
      if (my !== playToken) return;
      if (i + 1 < chunks.length) next = ttsChunk(chunks[i + 1]); // 先読み
      $('#playStatus').textContent = `再生中（${i + 1}/${chunks.length}）`;
      audio.src = src;
      await audio.play();
      await new Promise(res => { audio.onended = res; audio.onpause = () => { if (my !== playToken) res(); }; });
      if (my !== playToken) return;
    }
    $('#playStatus').textContent = '再生が終わりました';
  } catch (e) {
    if (my !== playToken) return;
    // Gemini TTSが使えないときはブラウザ音声で代替
    $('#playStatus').textContent = 'ブラウザの音声で読み上げます';
    const u = new SpeechSynthesisUtterance(state.guideData.narration); u.lang = 'ja-JP'; u.rate = 0.95;
    u.onend = () => { $('#playStatus').textContent = '再生が終わりました'; resetPlayer(); };
    speechSynthesis.cancel(); speechSynthesis.speak(u);
    return;
  }
  resetPlayer();
}
function resetPlayer() { $('#btnPlay').disabled = !state.guideData; $('#btnStop').disabled = true; }
function stopAudio() {
  playToken++; audio.pause(); audio.removeAttribute('src');
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('#playStatus').textContent = ''; resetPlayer();
}

function setupGuide() {
  $('#btnMakeGuide').onclick = async e => {
    const s = state.guideSpot; if (!s) return;
    busy(e.target, true, '解説を作成中…');
    try {
      const r = await api('generateGuide', { spotId: s.spotId }, { auth: true });
      state.guideData = r.guide; renderGuide(r.guide);
      $('#btnPlay').disabled = false;
      $('#playStatus').textContent = r.cached ? '保存済みの解説を表示しています' : '';
    } catch (ex) { toast(ex.message, 4000); }
    busy(e.target, false);
  };
  $('#btnPlay').onclick = playNarration;
  $('#btnStop').onclick = stopAudio;
  $('#btnHere').onclick = () => {
    const s = state.guideSpot;
    if (!hasPos(s)) { $('#hereInfo').textContent = 'このスポットには位置情報が登録されていません。'; return; }
    if (!navigator.geolocation) { $('#hereInfo').textContent = 'この端末では現在地を取得できません。'; return; }
    $('#hereInfo').textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition(p => {
      const d = km({ lat: p.coords.latitude, lng: p.coords.longitude }, s);
      $('#hereInfo').innerHTML = `現在地から直線で約 <strong>${d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km'}</strong>　` +
        `<a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener">ここへの道案内を開く</a>`;
    }, () => { $('#hereInfo').textContent = '現在地を取得できませんでした。位置情報の使用を許可してください。'; }, { enableHighAccuracy: true, timeout: 15000 });
  };
}

/* =========================================================
   画面切り替え・ヘルプ・起動
   ========================================================= */
function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === name));
  if (name !== 'guide') { /* ガイド音声は他画面でも継続再生 */ }
  setTimeout(() => { mapSearch.invalidateSize(); mapPlan.invalidateSize(); if (name === 'plan') renderPlan(); }, 50);
  window.scrollTo({ top: 0 });
}

function setupCommon() {
  $('#appVersion').textContent = C.VERSION;
  $('#footVersion').textContent = `${C.APP_NAME} ${C.VERSION}`;
  document.title = `${C.APP_NAME} ${C.VERSION}`;
  $$('.tabs button').forEach(b => b.onclick = () => showView(b.dataset.view));
  $('#btnHelp').onclick = () => $('#dlgHelp').showModal();
  $$('dialog [data-close]').forEach(b => b.onclick = () => {
    const d = b.closest('dialog'); if (d.dataset.force) return; d.close();
  });
  if (!LS.get('helpSeen', false)) { $('#dlgHelp').showModal(); LS.set('helpSeen', true); }
}

async function checkSession() {
  if (!state.token) return;
  try {
    const r = await api('me');
    setSession(state.token, r.user);
    if (r.isFirstLogin) openChange(true); else loadPlans();
  } catch { /* api()側で処理済み */ }
}

document.addEventListener('DOMContentLoaded', () => {
  setupCommon(); initMaps(); setupMics(); setupAuth(); setupSearch(); setupPlan(); setupMine(); setupGuide();
  renderAccount(); renderPlan(); renderPlanList();
  loadMaster(); checkSession();
});
})();
