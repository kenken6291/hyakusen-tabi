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

// 地方区分（8地方区分）
const REGIONS = [
  ['北海道', ['北海道']],
  ['東北', ['青森県','岩手県','宮城県','秋田県','山形県','福島県']],
  ['関東', ['茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県']],
  ['中部', ['新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県']],
  ['近畿', ['三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県']],
  ['中国', ['鳥取県','島根県','岡山県','広島県','山口県']],
  ['四国', ['徳島県','香川県','愛媛県','高知県']],
  ['九州・沖縄', ['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県']]
];
const REGION_OF = {}; REGIONS.forEach(([r, ps]) => ps.forEach(p => REGION_OF[p] = r));
const prefsOf = s => String(s.pref || '').split(/[・、,\s]+/).filter(Boolean);

const state = {
  token: LS.get('token', ''),
  user: LS.get('user', null),
  categories: [], spots: [],
  filter: Object.assign({ cat: '', region: '', pref: '', kw: '' }, LS.get('filter', {})),
  plan: LS.get('draft', null) || newPlan(),
  plans: [],
  guideSpot: null, guideData: null
};

function newPlan() {
  const last = LS.get('originHistory', [])[0] || null; // 前回の出発地を初期値に
  return { planId: '', title: '', date: '', start: '09:00', mode: 'car', memo: '', items: [], origin: last, returnHome: true };
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
const PIN = { radius: 7, weight: 2, color: '#FFFFFF', fillColor: '#2B4F7A', fillOpacity: 0.9 };
function initMaps() {
  const tiles = () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' });
  // preferCanvas：ピンをCanvasでまとめて描くので数百件でも軽い
  mapSearch = L.map('mapSearch', { preferCanvas: true }).setView(C.MAP.center, C.MAP.zoom); tiles().addTo(mapSearch);
  layerSearch = L.layerGroup().addTo(mapSearch);
  mapPlan = L.map('mapPlan', { preferCanvas: true }).setView(C.MAP.center, C.MAP.zoom); tiles().addTo(mapPlan);
  layerPlan = L.layerGroup().addTo(mapPlan);
}

async function loadMaster() {
  const cached = LS.get('master2', null);
  if (cached) applyMaster(cached);           // 手元のデータで即表示
  else $('#resultCount').textContent = '読み込み中…';
  try {
    const r = await api('getMaster', { version: cached ? cached.version : '' });
    if (r.unchanged) return;                 // 変更なし：通信はほぼ空
    const m = { version: r.version, categories: r.categories, spots: r.spots };
    LS.set('master2', m); LS.del('master');
    applyMaster(m);
  } catch (e) { if (!cached) toast('データを読み込めませんでした：' + e.message, 5000); }
}
function applyMaster(m) {
  state.masterVersion = m.version || '';
  state.categories = m.categories || [];
  state.spots = (m.spots || []).map(s => ({ ...s, lat: +s.lat, lng: +s.lng }));
  renderChips(); renderPlaceSelects(); renderSpots();
}
const catOf = id => state.categories.find(c => c.categoryId === id) || { name: id, icon: '📍' };

function renderChips() {
  const mk = c => `<button class="chip" type="button" data-cat="${esc(c.categoryId)}" aria-pressed="${state.filter.cat === c.categoryId}">${esc(c.icon || '')} ${esc(c.name)}</button>`;
  const all = `<button class="chip" type="button" data-cat="" aria-pressed="${!state.filter.cat}">すべて</button>`;
  $('#chipsMain').innerHTML = all + state.categories.filter(c => c.group === 'main').map(mk).join('');
  $('#chipsOther').innerHTML = state.categories.filter(c => c.group !== 'main').map(mk).join('');
  $$('#chipsMain .chip, #chipsOther .chip').forEach(b => b.onclick = () => {
    state.filter.cat = b.dataset.cat; renderChips(); renderPlaceSelects(); renderSpots();
  });
}

/** 地方・都道府県以外の条件（分野・キーワード）で絞ったもの。件数表示に使う */
function baseSpots() {
  const { cat, kw } = state.filter;
  const k = kw.trim().toLowerCase();
  return state.spots.filter(s => (!cat || s.category === cat) &&
    (!k || (s.name + s.description + s.pref).toLowerCase().includes(k)));
}
function filteredSpots() {
  const { region, pref } = state.filter;
  return baseSpots().filter(s => {
    const ps = prefsOf(s);
    if (pref) return ps.includes(pref);
    if (region) return ps.some(p => REGION_OF[p] === region);
    return true;
  });
}
/** 地方・都道府県の選択肢（件数つき）を作り直す */
function renderPlaceSelects() {
  const base = baseSpots();
  const prefCount = {}, regionCount = {};
  base.forEach(s => {
    const ps = prefsOf(s);
    ps.forEach(p => prefCount[p] = (prefCount[p] || 0) + 1);
    [...new Set(ps.map(p => REGION_OF[p]).filter(Boolean))].forEach(r => regionCount[r] = (regionCount[r] || 0) + 1);
  });
  const f = state.filter;
  $('#selRegion').innerHTML = `<option value="">全国（${base.length}）</option>` +
    REGIONS.map(([r]) => `<option value="${r}" ${f.region === r ? 'selected' : ''}>${r}（${regionCount[r] || 0}）</option>`).join('');
  const prefs = f.region ? REGIONS.find(x => x[0] === f.region)[1] : PREFS;
  if (f.pref && !prefs.includes(f.pref)) f.pref = '';
  $('#selPref').innerHTML = `<option value="">${f.region ? f.region + 'すべて' : 'すべて'}</option>` +
    prefs.map(p => `<option value="${p}" ${f.pref === p ? 'selected' : ''} ${prefCount[p] ? '' : 'class="zero"'}>${p}（${prefCount[p] || 0}）</option>`).join('');
  renderFilterBar();
}
/** 選んでいる条件を表示し、×で個別に外せるようにする */
function renderFilterBar() {
  const f = state.filter, tags = [];
  if (f.cat) tags.push(['cat', catOf(f.cat).name]);
  if (f.region) tags.push(['region', f.region]);
  if (f.pref) tags.push(['pref', f.pref]);
  if (f.kw.trim()) tags.push(['kw', `「${f.kw.trim()}」`]);
  $('#filterBar').innerHTML = tags.length
    ? tags.map(([k, v]) => `<button class="chip" type="button" data-unset="${k}" aria-label="${esc(v)}の条件を外す">${esc(v)} ×</button>`).join('') +
      (tags.length > 1 ? `<button class="btn small ghost" type="button" data-unset="all">条件をすべて外す</button>` : '')
    : '';
  LS.set('filter', f);
}

let lastRenderKey = '';
function renderSpots() {
  const list = filteredSpots();
  const key = JSON.stringify(state.filter) + '|' + state.spots.length + '|' + (state.masterVersion || '');
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  $('#resultCount').textContent = list.length > 200 ? `${list.length} 件（一覧は先頭200件。分野や都道府県で絞り込むと全部見られます）` : `${list.length} 件`;
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
    L.circleMarker([s.lat, s.lng], PIN).bindPopup(`<b>${esc(s.name)}</b><br>${esc(catOf(s.category).name)}`).addTo(layerSearch);
    pts.push([s.lat, s.lng]);
  });
  if (pts.length) mapSearch.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
}

function setupSearch() {
  $('#selRegion').onchange = e => { state.filter.region = e.target.value; state.filter.pref = ''; renderPlaceSelects(); renderSpots(); };
  $('#selPref').onchange = e => {
    state.filter.pref = e.target.value;
    if (e.target.value && !state.filter.region) state.filter.region = REGION_OF[e.target.value] || '';
    renderPlaceSelects(); renderSpots();
  };
  $('#txtKeyword').value = state.filter.kw;
  $('#filterBar').addEventListener('click', e => {
    const b = e.target.closest('[data-unset]'); if (!b) return;
    const k = b.dataset.unset;
    if (k === 'all') Object.assign(state.filter, { cat: '', region: '', pref: '', kw: '' });
    else { state.filter[k] = ''; if (k === 'region') state.filter.pref = ''; }
    if (k === 'kw' || k === 'all') $('#txtKeyword').value = '';
    renderChips(); renderPlaceSelects(); renderSpots();
  });
  let t; $('#txtKeyword').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.filter.kw = e.target.value; renderPlaceSelects(); renderSpots(); }, 250); });
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

/** 位置が後から登録されたスポットの座標を、最新の百選データで補う */
function syncItemCoords() {
  state.plan.items.forEach(it => {
    if (it.type !== 'spot' || hasPos(it)) return;
    const s = state.spots.find(x => x.spotId === it.spotId);
    if (hasPos(s)) { it.lat = s.lat; it.lng = s.lng; }
  });
}
function renderOrigin() {
  const o = state.plan.origin;
  $('#returnHome').checked = state.plan.returnHome !== false;
  if (o && o.name) {
    $('#originText').value = o.name;
    $('#originSet').innerHTML = `出発地：<strong>${esc(o.name)}</strong>`;
  } else {
    $('#originSet').textContent = '出発地が未設定です。設定すると最初のスポットまでの移動時間も計算します。';
  }
  const hist = LS.get('originHistory', []);
  $('#originHistory').innerHTML = hist.map(h => `<option value="${esc(h.name)}"></option>`).join('');
}
function setOrigin(o) {
  state.plan.origin = o;
  if (o && hasPos(o) && o.name !== '現在地') { // 現在地は場所が変わるので履歴に残さない
    const hist = LS.get('originHistory', []).filter(h => h.name !== o.name);
    hist.unshift(o); LS.set('originHistory', hist.slice(0, 8));
  }
  $('#originCands').innerHTML = '';
  saveDraft(); renderPlan();
}

/* ---------- 経路の所要時間（Googleの経路検索をGAS経由で） ---------- */
const MODE_NAME = { car: '車', walk: '徒歩', bike: '自転車', transit: '電車・バス' };
function routePoints() {
  const p = state.plan, o = p.origin && p.origin.name ? p.origin : null, pts = [];
  if (o) pts.push({ name: o.name, lat: o.lat, lng: o.lng, stay: 0, home: true });
  p.items.forEach(it => {
    const s = state.spots.find(x => x.spotId === it.spotId);
    pts.push({ name: it.name, pref: s ? s.pref : '', lat: it.lat, lng: it.lng, stay: +it.stay || 0, custom: it.type === 'custom' });
  });
  if (o && p.returnHome !== false && p.items.length) pts.push({ name: o.name, lat: o.lat, lng: o.lng, stay: 0, home: true });
  return pts;
}
// 座標は含めない（自動で位置が補われても再計算しないため）。出発地だけは座標を含める
function routeSig(pts) {
  const p = state.plan;
  return JSON.stringify([p.mode, p.date, p.start, pts.map(x => x.home || x.custom ? [x.name, x.stay, !!x.custom, x.lat || 0, x.lng || 0] : [x.name, x.stay])]);
}
let routeTimer = null;
function scheduleRoute(sig, pts, fresh) {
  if (state.routePending === sig && !fresh) return;
  clearTimeout(routeTimer);
  if (pts.length < 2) return;
  state.routePending = sig;
  routeTimer = setTimeout(async () => {
    try {
      const r = await api('routeTimes', { mode: state.plan.mode, date: state.plan.date, start: state.plan.start, points: pts, fresh: !!fresh });
      if (state.routePending !== sig) return;
      // 位置が見つかったスポットは計画に書き戻す（地図にも出る）
      const off = state.plan.origin && state.plan.origin.name ? 1 : 0;
      state.plan.items.forEach((it, k) => {
        const q = r.points[k + off];
        if (q && !hasPos(it)) { it.lat = q.lat; it.lng = q.lng; }
      });
      state.plan.route = { sig, legs: r.legs, at: Date.now() }; // 計画に経路を盛り込む（保存対象）
      saveDraft();
    } catch (e) {
      toast('経路の検索に失敗しました：' + e.message, 4000);
      state.routeFail = sig;
    }
    state.routePending = '';
    renderPlan();
  }, 600);
}
function estimateLeg(pts, i) {
  const cur = pts[i];
  if (cur.custom && !hasPos(cur)) return { minutes: 0, source: 'custom' };
  let j = i - 1; while (j >= 0 && !hasPos(pts[j])) j--;
  if (j < 0 || !hasPos(cur)) return { minutes: null, source: 'none' };
  return { minutes: travelMin(pts[j], cur), source: 'line' };
}
const GMODE = { car: 'driving', walk: 'walking', bike: 'bicycling', transit: 'transit' };
function stepHtml(s) {
  if (s.type === 'transit') {
    return `<li class="rs-transit"><span class="rs-time">${esc(s.dep)}</span> ${esc(s.from)} 発<br>
      <span class="rs-line">${esc(s.line || s.vehicle)}</span>${s.headsign ? `（${esc(s.headsign)}行）` : ''}${s.stops ? `　${s.stops}駅` : ''}<br>
      <span class="rs-time">${esc(s.arr)}</span> ${esc(s.to)} 着</li>`;
  }
  if (s.type === 'walk') return `<li class="rs-walk">徒歩 ${s.minutes}分${s.text ? '　' + esc(s.text) : ''}</li>`;
  return `<li class="rs-drive">${esc(s.text)}（${s.km}km・${s.minutes}分）</li>`;
}
function moveHtml(l, pending) {
  if (!l || l.source === 'custom') return '';
  if (l.minutes == null) return `<li class="move warn">位置が登録されていないため、移動時間を計算できません</li>`;
  const mode = MODE_NAME[state.plan.mode];
  const calc = pending ? '<span class="calc">経路を検索中…</span>' : '';
  const link = l.from && l.to
    ? `<a class="rs-link" href="https://www.google.com/maps/dir/?api=1&origin=${l.from.join(',')}&destination=${l.to.join(',')}&travelmode=${GMODE[state.plan.mode]}" target="_blank" rel="noopener">この区間をGoogleマップで見る</a>` : '';
  if (l.source === 'google') {
    const head = `${mode} 約${l.minutes}分${l.wait ? `（待ち${l.wait}分を含む）` : ''}　${l.km}km${l.summary ? '　' + esc(l.summary) : ''}`;
    if (l.steps && l.steps.length) {
      return `<li class="move route"><details ${state.plan.mode === 'transit' ? 'open' : ''}><summary>${head}${calc}</summary>
        <ol class="rsteps">${l.steps.map(stepHtml).join('')}</ol>${link}</details></li>`;
    }
    return `<li class="move route">${head}${calc}<br>${link}</li>`;
  }
  const note = l.source === 'estimate' ? '車の経路から推定' : '直線距離からの目安';
  return `<li class="move">${mode} 約${l.minutes}分（${note}）${calc}${link ? '<br>' + link : ''}</li>`;
}

/** 行程の1項目。立ち寄り（custom）は名前・場所も編集できる */
function stopHtml(it, k, arrive, n) {
  const custom = it.type === 'custom';
  const editing = state.editIndex === k;
  const name = esc(it.name);
  const view = `
        <h4>${name}${custom ? '<span class="tag">立ち寄り</span>' : ''}</h4>
        ${custom && it.place ? `<div class="place">📍 ${esc(it.place)}</div>` : ''}
        ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
        <div class="row">
          <label>${custom ? '必要時間' : '滞在'} <input type="number" min="0" max="1440" step="5" value="${esc(it.stay)}" data-stay="${k}" aria-label="${name}の${custom ? '必要時間' : '滞在時間'}（分）"> 分</label>
          <button class="btn small ghost" type="button" data-up="${k}" ${k === 0 ? 'disabled' : ''} aria-label="${name}を前へ">▲</button>
          <button class="btn small ghost" type="button" data-down="${k}" ${k === n - 1 ? 'disabled' : ''} aria-label="${name}を後へ">▼</button>
          <button class="btn small" type="button" data-edit="${k}" aria-expanded="${editing}">編集</button>
          ${custom ? '' : `<button class="btn small" type="button" data-gd="${esc(it.spotId)}">案内を見る</button>`}
          <button class="btn small danger" type="button" data-rm="${k}">${custom ? '削除' : '外す'}</button>
        </div>`;
  const form = !editing ? '' : `
        <div class="editbox" data-editbox="${k}">
          ${custom ? `<div class="field"><label for="ed-name-${k}">名前</label><input type="text" id="ed-name-${k}" value="${name}" maxlength="60"></div>` : ''}
          <div class="addgrid">
            <div class="field"><label for="ed-stay-${k}">${custom ? '必要時間' : '滞在時間'}（分）</label><input type="number" id="ed-stay-${k}" min="0" max="1440" step="5" value="${esc(it.stay)}"></div>
            <div class="field"><label for="ed-note-${k}">メモ</label><input type="text" id="ed-note-${k}" value="${esc(it.note || '')}" maxlength="200"></div>
          </div>
          ${custom ? `<div class="field"><label for="ed-place-${k}">場所（任意）</label>
            <div class="withmic"><input type="text" id="ed-place-${k}" value="${esc(it.place || '')}" placeholder="店名・住所など">
            <button class="btn small" type="button" data-edsearch="${k}">検索</button>
            ${it.place ? `<button class="btn small ghost" type="button" data-edclear="${k}">場所を外す</button>` : ''}</div>
            <ul class="cands" id="ed-cands-${k}"></ul></div>` : ''}
          <div class="row">
            <button class="btn small primary" type="button" data-edsave="${k}">変更を保存</button>
            <button class="btn small ghost" type="button" data-edcancel="${k}">取り消す</button>
          </div>
        </div>`;
  return `<li class="stop${custom ? ' custom' : ''}">
      <div class="t">${toHM(arrive)}</div><div class="dot"></div>
      <div class="body">${view}${form}</div></li>`;
}
/** 「入れる位置」の選択肢 */
function renderCustomPos() {
  const sel = $('#customPos'); if (!sel) return;
  const keep = sel.value;
  const items = state.plan.items;
  sel.innerHTML = `<option value="end">いちばん最後</option><option value="0">いちばん最初</option>` +
    items.map((it, i) => `<option value="${i + 1}">「${esc(it.name)}」のあと</option>`).join('');
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}
async function placeSearch(q) {
  const r = await api('geocode', { query: q });
  return r.results || [];
}

function renderPlan() {
  // 編集中の入力値は、経路の再計算などで描き直しても消えないように控えておく
  const keep = {};
  if (state.editIndex != null) ['name', 'stay', 'note', 'place'].forEach(f => {
    const el = $(`#ed-${f}-${state.editIndex}`); if (el) keep[f] = el.value;
  });
  if (state.editIndex != null && state.editIndex >= state.plan.items.length) state.editIndex = null;
  syncItemCoords();
  renderCustomPos();
  const p = state.plan;
  $('#planTitle').value = p.title; $('#planDate').value = p.date; $('#planStart').value = p.start;
  $('#planMode').value = p.mode; $('#planMemo').value = p.memo;
  renderOrigin();
  const o = p.origin && p.origin.name ? p.origin : null;

  const pts = routePoints();
  const sig = routeSig(pts);
  const saved = p.route && p.route.sig === sig && p.route.legs ? p.route : null;
  const route = saved;
  if (!route && state.routeFail !== sig) scheduleRoute(sig, pts);
  const pending = !route && state.routePending === sig;
  const legAt = i => route ? route.legs[i - 1] : estimateLeg(pts, i);
  const schedule = []; // AI相談用の時刻表

  let t = toMin(p.start);
  let html = '';
  if (o) {
    html += `<li class="stop home"><div class="t">${toHM(t)}</div><div class="dot"></div>
      <div class="body"><h4>出発：${esc(o.name)}</h4></div></li>`;
    schedule.push(`${toHM(t)} 出発：${o.name}`);
  }
  p.items.forEach((it, k) => {
    const i = o ? k + 1 : k;
    const l = i > 0 ? legAt(i) : null;
    if (l && l.minutes) {
      t += l.minutes;
      schedule.push(`　移動 ${l.minutes}分（${MODE_NAME[p.mode]}${l.wait ? '・待ち' + l.wait + '分' : ''}${l.summary ? '：' + l.summary : ''}）`);
      (l.steps || []).filter(s => s.type === 'transit').forEach(s => schedule.push(`　　${s.dep} ${s.from} → ${s.line} → ${s.arr} ${s.to}`));
    }
    html += moveHtml(l, pending);
    const arrive = t; t += (+it.stay || 0);
    schedule.push(`${toHM(arrive)} ${it.name}（滞在${+it.stay || 0}分）`);
    html += stopHtml(it, k, arrive, p.items.length);
  });
  if (p.items.length) {
    if (o && p.returnHome !== false) {
      const l = legAt(pts.length - 1);
      if (l && l.minutes) {
        t += l.minutes; schedule.push(`　移動 ${l.minutes}分${l.summary ? '（' + l.summary + '）' : ''}`);
        (l.steps || []).filter(s => s.type === 'transit').forEach(s => schedule.push(`　　${s.dep} ${s.from} → ${s.line} → ${s.arr} ${s.to}`));
      }
      html += moveHtml(l, pending) +
        `<li class="stop home"><div class="t">${toHM(t)}</div><div class="dot"></div>
          <div class="body"><h4>帰着：${esc(o.name)}</h4></div></li>`;
      schedule.push(`${toHM(t)} 帰着：${o.name}`);
    } else {
      html += `<li class="move">行程終了の目安 ${toHM(t)}</li>`;
    }
    if (t >= 24 * 60) html += `<li class="move warn">日付をまたぐ行程です。出発を早めるか、スポットや滞在時間を減らしてください。</li>`;
  } else {
    html += '<li class="empty">「さがす」でスポットの「計画に追加」を押すと、ここに行程が並びます。</li>';
  }
  $('#stopList').innerHTML = html;
  Object.keys(keep).forEach(f => { const el = $(`#ed-${f}-${state.editIndex}`); if (el) el.value = keep[f]; });
  state.scheduleText = schedule.join('\n');

  layerPlan.clearLayers();
  const line = p.items.filter(hasPos).map(x => [+x.lat, +x.lng]);
  if (o && hasPos(o)) {
    L.circleMarker([+o.lat, +o.lng], { radius: 9, weight: 3, color: '#FFFFFF', fillColor: '#8A5A2B', fillOpacity: 1 })
      .bindTooltip('出発地：' + o.name).addTo(layerPlan);
    line.unshift([+o.lat, +o.lng]);
    if (p.returnHome !== false && p.items.some(hasPos)) line.push([+o.lat, +o.lng]);
  }
  p.items.forEach((x, i) => {
    if (!hasPos(x)) return;
    const style = x.type === 'custom' ? Object.assign({}, PIN, { fillColor: '#5B8C5A', radius: 6 }) : PIN;
    L.circleMarker([+x.lat, +x.lng], style).bindTooltip(`${i + 1}. ${x.name}`).addTo(layerPlan);
  });
  if (line.length > 1) L.polyline(line, { color: '#2B4F7A', weight: 4, dashArray: '6 6' }).addTo(layerPlan);
  if (line.length) mapPlan.fitBounds(line, { padding: [30, 30], maxZoom: 13 });
}

function setupPlan() {
  const bind = (id, key) => $(id).addEventListener('input', e => { state.plan[key] = e.target.value; saveDraft(); if (key === 'start' || key === 'mode') renderPlan(); });
  bind('#planTitle', 'title'); bind('#planDate', 'date'); bind('#planStart', 'start'); bind('#planMemo', 'memo');
  $('#planMode').onchange = e => { state.plan.mode = e.target.value; saveDraft(); renderPlan(); };
  $('#stopList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const items = state.plan.items, d = b.dataset;
    if (d.up) { const i = +d.up; [items[i - 1], items[i]] = [items[i], items[i - 1]]; state.editIndex = null; }
    else if (d.down) { const i = +d.down; [items[i + 1], items[i]] = [items[i], items[i + 1]]; state.editIndex = null; }
    else if (d.rm) {
      const it = items[+d.rm];
      if (it.type === 'custom' && !confirm(`立ち寄り「${it.name}」を削除しますか？`)) return;
      items.splice(+d.rm, 1); state.editIndex = null;
    }
    else if (d.gd) return openGuide(d.gd);
    else if (d.edit) { state.editIndex = state.editIndex === +d.edit ? null : +d.edit; state.editPlace = null; }
    else if (d.edcancel) { state.editIndex = null; state.editPlace = null; }
    else if (d.edclear) { const it = items[+d.edclear]; it.place = ''; it.lat = ''; it.lng = ''; }
    else if (d.edsearch) {
      const k = +d.edsearch, q = $('#ed-place-' + k).value.trim();
      if (!q) { toast('場所を入れてください'); return; }
      busy(b, true, '検索中…');
      placeSearch(q).then(list => {
        busy(b, false);
        state.editCands = list;
        $('#ed-cands-' + k).innerHTML = list.length
          ? list.map((c, i) => `<li><button type="button" data-edpick="${k}" data-i="${i}">${esc(c.name)}</button></li>`).join('')
          : '<li class="hint">見つかりませんでした。店名と市町村名を一緒に入れてみてください。</li>';
      }).catch(ex => { busy(b, false); toast(ex.message, 4000); });
      return;
    }
    else if (d.edpick) {
      const c = state.editCands[+d.i];
      state.editPlace = { place: c.name, lat: c.lat, lng: c.lng };
      $('#ed-place-' + d.edpick).value = c.name;
      $('#ed-cands-' + d.edpick).innerHTML = `<li class="hint">「変更を保存」で場所が確定します</li>`;
      return;
    }
    else if (d.edsave) {
      const k = +d.edsave, it = items[k];
      if (it.type === 'custom') {
        const nm = $('#ed-name-' + k).value.trim();
        if (!nm) { toast('名前を入れてください'); return; }
        it.name = nm;
        if (state.editPlace) Object.assign(it, state.editPlace);
      }
      it.stay = Math.max(0, Math.min(1440, +$('#ed-stay-' + k).value || 0));
      it.note = $('#ed-note-' + k).value.trim().slice(0, 200);
      state.editIndex = null; state.editPlace = null;
      toast('変更を保存しました（計画の保存は「計画を保存」で）');
    }
    else return;
    saveDraft(); renderPlan();
  });
  $('#stopList').addEventListener('change', e => {
    if (e.target.dataset.stay) { state.plan.items[+e.target.dataset.stay].stay = Math.max(0, +e.target.value || 0); saveDraft(); renderPlan(); }
  });
  const searchOrigin = async () => {
    const q = $('#originText').value.trim();
    if (!q) { toast('出発地を入れてください'); return; }
    const hist = LS.get('originHistory', []).find(h => h.name === q);
    if (hist) { setOrigin(hist); return; }
    const btn = $('#btnOriginSearch'); busy(btn, true, '検索中…');
    try {
      const r = await api('geocode', { query: q });
      if (!r.results.length) { $('#originCands').innerHTML = '<li class="hint">見つかりませんでした。駅名や住所を変えてお試しください。</li>'; }
      else if (r.results.length === 1) setOrigin({ ...r.results[0], name: q.length <= 20 ? q : r.results[0].name });
      else $('#originCands').innerHTML = r.results.map((c, i) => `<li><button type="button" data-cand="${i}">${esc(c.name)}</button></li>`).join('');
      state._cands = r.results; state._candQ = q;
    } catch (ex) { toast(ex.message, 4000); }
    busy(btn, false);
  };
  $('#btnOriginSearch').onclick = searchOrigin;
  $('#originText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchOrigin(); } });
  $('#originText').addEventListener('change', e => {
    const h = LS.get('originHistory', []).find(x => x.name === e.target.value.trim());
    if (h) setOrigin(h);
  });
  $('#originCands').addEventListener('click', e => {
    const b = e.target.closest('[data-cand]'); if (!b) return;
    const c = state._cands[+b.dataset.cand];
    setOrigin({ name: state._candQ && state._candQ.length <= 20 ? `${state._candQ}（${c.name}）` : c.name, lat: c.lat, lng: c.lng });
  });
  $('#btnOriginHere').onclick = () => {
    if (!navigator.geolocation) { toast('この端末では現在地を取得できません'); return; }
    const btn = $('#btnOriginHere'); busy(btn, true, '取得中…');
    navigator.geolocation.getCurrentPosition(pos => {
      busy(btn, false);
      setOrigin({ name: '現在地', lat: Math.round(pos.coords.latitude * 1e5) / 1e5, lng: Math.round(pos.coords.longitude * 1e5) / 1e5 });
    }, () => { busy(btn, false); toast('現在地を取得できませんでした。位置情報の使用を許可してください。'); },
    { enableHighAccuracy: true, timeout: 15000 });
  };
  $('#returnHome').onchange = e => { state.plan.returnHome = e.target.checked; saveDraft(); renderPlan(); };

  // よく使う立ち寄り
  $$('[data-preset]').forEach(b => b.onclick = () => {
    const [nm, min] = b.dataset.preset.split('|');
    $('#customStop').value = nm; $('#customStay').value = min; $('#customStop').focus();
  });
  // 立ち寄りの場所検索
  state.customPlace = null;
  $('#btnCustomPlace').onclick = async e => {
    const q = $('#customPlace').value.trim();
    if (!q) { toast('場所を入れてください'); return; }
    busy(e.target, true, '検索中…');
    try {
      const list = await placeSearch(q);
      state.customCands = list;
      $('#customCands').innerHTML = list.length
        ? list.map((c, i) => `<li><button type="button" data-ccand="${i}">${esc(c.name)}</button></li>`).join('')
        : '<li class="hint">見つかりませんでした。店名と市町村名を一緒に入れてみてください。</li>';
    } catch (ex) { toast(ex.message, 4000); }
    busy(e.target, false);
  };
  $('#customPlace').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#btnCustomPlace').click(); } });
  $('#customPlace').addEventListener('input', () => { state.customPlace = null; $('#customPlaceSet').textContent = ''; });
  $('#customCands').addEventListener('click', e => {
    const b = e.target.closest('[data-ccand]'); if (!b) return;
    const c = state.customCands[+b.dataset.ccand];
    state.customPlace = { place: c.name, lat: c.lat, lng: c.lng };
    $('#customCands').innerHTML = '';
    $('#customPlaceSet').innerHTML = `場所：<strong>${esc(c.name)}</strong>`;
  });
  $('#btnAddCustom').onclick = () => {
    const v = $('#customStop').value.trim();
    if (!v) { toast('立ち寄りの名前を入れてください'); $('#customStop').focus(); return; }
    if ($('#customPlace').value.trim() && !state.customPlace) {
      if (!confirm('場所がまだ確定していません（「検索」で候補を選ぶと移動時間も計算できます）。場所なしで追加しますか？')) return;
    }
    const item = {
      type: 'custom', name: v.slice(0, 60),
      stay: Math.max(0, Math.min(1440, +$('#customStay').value || 0)),
      note: $('#customNote').value.trim().slice(0, 200),
      place: '', lat: '', lng: ''
    };
    if (state.customPlace) Object.assign(item, state.customPlace);
    const pos = $('#customPos').value;
    const items = state.plan.items;
    if (pos === 'end') items.push(item); else items.splice(Math.min(+pos, items.length), 0, item);
    ['#customStop', '#customPlace', '#customNote'].forEach(id => $(id).value = '');
    $('#customStay').value = 30; $('#customCands').innerHTML = ''; $('#customPlaceSet').textContent = '';
    state.customPlace = null; state.editIndex = null;
    saveDraft(); renderPlan();
    toast(`「${item.name}」を行程に追加しました`);
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
    const o = state.plan.origin && hasPos(state.plan.origin) ? state.plan.origin : null;
    const back = o && state.plan.returnHome !== false;
    const dest = back ? o : stops[stops.length - 1];
    const wayStops = back ? stops : stops.slice(0, -1);
    const way = wayStops.slice(0, 9).map(ll).join('|');
    const mode = { car: 'driving', walk: 'walking', bike: 'bicycling', transit: 'transit' }[state.plan.mode];
    if (mode === 'transit' && stops.length > 1) toast('公共交通では経由地が使えないため、最初のスポットまでの案内を開きます', 4000);
    const transitDest = mode === 'transit' ? stops[0] : dest;
    const url = `https://www.google.com/maps/dir/?api=1` +
      (o ? `&origin=${encodeURIComponent(ll(o))}` : '') +
      `&destination=${encodeURIComponent(ll(transitDest))}` +
      (way && mode !== 'transit' ? `&waypoints=${encodeURIComponent(way)}` : '') + `&travelmode=${mode}`;
    window.open(url, '_blank', 'noopener');
  };
  $('#btnReroute').onclick = () => {
    const pts = routePoints();
    if (pts.filter(hasPos).length < 2 && !pts.some(x => !x.custom && !hasPos(x))) { toast('出発地とスポットを入れてください'); return; }
    state.plan.route = null; state.routeFail = '';
    scheduleRoute(routeSig(pts), pts, true);
    renderPlan();
  };
  $('#btnAdvice').onclick = async e => {
    if (!state.plan.items.length) { toast('行程を1つ以上入れてください'); return; }
    busy(e.target, true, 'AIが確認中…');
    try {
      const r = await api('planAdvice', { plan: state.plan, schedule: state.scheduleText }, { auth: true });
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
  const local = LS.get('guide_' + s.spotId, null);
  if (local) { state.guideData = local; renderGuide(local); $('#btnPlay').disabled = false; }
  loadSpotMemories(s.spotId);
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
const ttsMemo = new Map();
async function ttsChunk(text) {
  if (ttsMemo.has(text)) return ttsMemo.get(text);
  const p = api('tts', { text, voice: C.TTS.voice }, { auth: true })
    .then(r => 'data:audio/wav;base64,' + r.audio)
    .catch(e => { ttsMemo.delete(text); throw e; });
  ttsMemo.set(text, p);
  if (ttsMemo.size > 40) ttsMemo.delete(ttsMemo.keys().next().value);
  return p;
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
    const local = LS.get('guide_' + s.spotId, null);
    if (local) {
      state.guideData = local; renderGuide(local);
      $('#btnPlay').disabled = false; $('#playStatus').textContent = '保存済みの解説を表示しています';
      return;
    }
    busy(e.target, true, '解説を作成中…');
    try {
      const r = await api('generateGuide', { spotId: s.spotId }, { auth: true });
      LS.set('guide_' + s.spotId, r.guide);
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
   想い出の記録（写真・動画・URL）
   ========================================================= */
const driveThumb = (id, w = 600) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
const driveView = id => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
const drivePreview = id => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
}
function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : '';
}

/* --- 写真の縮小とアップロード（3MBずつ分割して送る） --- */
async function shrinkImage(file) {
  const max = (C.MEMORY && C.MEMORY.maxPhotoPx) || 1920;
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w0 = src.width, h0 = src.height, r = Math.min(1, max / Math.max(w0, h0));
  const cv = document.createElement('canvas'); cv.width = Math.round(w0 * r); cv.height = Math.round(h0 * r);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return await new Promise(res => cv.toBlob(b => res(b || file), 'image/jpeg', 0.85));
}
function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
}
async function uploadMedia(file, onProgress) {
  let blob = file, mime = file.type || '', name = file.name || 'file';
  const isVideo = mime.startsWith('video/');
  if (!isVideo && !mime.startsWith('image/')) throw new Error(`「${name}」は写真・動画ではありません`);
  if (!isVideo && mime !== 'image/gif') { blob = await shrinkImage(file); mime = 'image/jpeg'; name = name.replace(/\.\w+$/, '') + '.jpg'; }
  const maxMB = (C.MEMORY && C.MEMORY.maxVideoMB) || 100;
  if (blob.size > maxMB * 1048576) throw new Error(`「${name}」は${maxMB}MBを超えています。YouTubeなどに上げてURLで登録してください`);
  const st = await api('startUpload', { name, mime, size: blob.size }, { auth: true });
  let off = 0, res = null;
  while (off < blob.size) {
    const part = blob.slice(off, off + st.chunk);
    res = await api('uploadChunk', { uploadId: st.uploadId, offset: off, data: await blobToBase64(part) }, { auth: true });
    off += part.size;
    onProgress(off / blob.size);
  }
  if (!res || !res.fileId) throw new Error('アップロードが完了しませんでした');
  return { type: isVideo ? 'video' : 'photo', fileId: res.fileId, name, mime };
}

/* --- 一覧 --- */
state.memScope = 'mine';
state.memories = [];
function memThumb(m) {
  const ph = (m.media || []).find(x => x.type === 'photo') || (m.media || []).find(x => x.type === 'video');
  if (ph) return `<img src="${driveThumb(ph.fileId, 500)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${ph.type === 'video' ? '🎬' : '🖼'}'))">`;
  const u = (m.media || []).find(x => x.type === 'url');
  if (u && youtubeId(u.url)) return `<img src="https://i.ytimg.com/vi/${youtubeId(u.url)}/hqdefault.jpg" alt="" loading="lazy">`;
  if (u && u.image) return `<img src="${esc(u.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
  return '📝';
}
function memCard(m, showWho) {
  const n = { photo: 0, video: 0, url: 0 }; (m.media || []).forEach(x => n[x.type]++);
  const counts = [n.photo && `📷${n.photo}`, n.video && `🎬${n.video}`, n.url && `🔗${n.url}`].filter(Boolean).join(' ');
  return `<li><button class="memcard" type="button" data-mem="${esc(m.memoryId)}">
    <div class="ph">${memThumb(m)}</div>
    <div class="tx"><h3>${esc(m.title)}</h3>
      <div class="meta">${esc(fmtDate(m.date))}${m.spotName ? '　📍' + esc(m.spotName) : ''}</div>
      <div class="meta">${counts}${showWho ? `　${esc(m.nickname)} さん` : ''}${m.visibility === 'members' ? '　会員に公開' : ''}</div>
    </div></button></li>`;
}
async function loadMemories() {
  const ul = $('#memList');
  if (!state.user) { ul.innerHTML = '<li class="empty">想い出の記録にはログインが必要です。<button class="btn small primary" type="button" data-login>ログイン・新規登録</button></li>'; return; }
  ul.innerHTML = '<li class="empty">読み込み中…</li>';
  try {
    const r = await api('listMemories', { scope: state.memScope }, { auth: true });
    state.memories = r.memories;
    ul.innerHTML = r.memories.length ? r.memories.map(m => memCard(m, state.memScope === 'all')).join('')
      : `<li class="empty">${state.memScope === 'mine' ? 'まだ想い出がありません。「＋ 想い出を記録」から写真や動画を残しましょう。' : '会員に公開された想い出はまだありません。'}</li>`;
  } catch (e) { ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
}
async function loadSpotMemories(spotId) {
  const box = $('#guideMemList');
  if (!state.user) { box.innerHTML = '<p class="hint">ログインすると、この場所の想い出を見たり記録したりできます。</p>'; return; }
  box.innerHTML = '<p class="hint">読み込み中…</p>';
  try {
    const r = await api('listMemories', { spotId }, { auth: true });
    state.spotMemories = r.memories;
    box.innerHTML = r.memories.length ? r.memories.map(m => memCard(m, true).replace(/^<li>|<\/li>$/g, '')).join('')
      : '<p class="hint">まだこの場所の想い出はありません。</p>';
  } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

/* --- 表示 --- */
const findMemory = id => state.memories.find(x => x.memoryId === id) || (state.spotMemories || []).find(x => x.memoryId === id);
function openMemoryView(id) {
  const m = findMemory(id); if (!m) return;
  const photos = m.media.filter(x => x.type === 'photo');
  const videos = m.media.filter(x => x.type === 'video');
  const urls = m.media.filter(x => x.type === 'url');
  const yt = urls.filter(u => youtubeId(u.url));
  $('#memView').innerHTML = `
    <h2 id="memViewTitle">${esc(m.title)}</h2>
    <p class="mv-meta">${esc(fmtDate(m.date))}${m.spotName ? '　📍' + esc(m.spotName) : ''}${m.planTitle ? '　🗓 ' + esc(m.planTitle) : ''}　${esc(m.nickname)} さん　${m.visibility === 'members' ? '会員に公開' : '自分だけ'}</p>
    ${m.text ? `<p class="mv-text">${esc(m.text)}</p>` : ''}
    ${photos.length ? `<div class="mv-photos">${photos.map(p => `<a href="${driveView(p.fileId)}" target="_blank" rel="noopener" aria-label="写真を大きく見る"><img src="${driveThumb(p.fileId, 900)}" alt="${esc(p.name)}" loading="lazy"></a>`).join('')}</div>` : ''}
    ${videos.map(v => `<div class="mv-video"><iframe class="video" src="${drivePreview(v.fileId)}" allow="autoplay; fullscreen" allowfullscreen title="${esc(v.name)}"></iframe>
      <p class="hint">アップロード直後は、Googleドライブ側の準備ができるまで再生できないことがあります。</p></div>`).join('')}
    ${yt.map(u => `<div class="mv-video"><iframe class="video" src="https://www.youtube-nocookie.com/embed/${youtubeId(u.url)}" allow="fullscreen; picture-in-picture" allowfullscreen title="${esc(u.title || 'YouTube動画')}"></iframe></div>`).join('')}
    ${urls.length ? `<ul class="mv-urls">${urls.map(u => `<li><a href="${esc(u.url)}" target="_blank" rel="noopener">
        ${u.image ? `<img src="${esc(u.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : '<span aria-hidden="true">🔗</span>'}
        <span>${esc(u.title || u.url)}<small>${esc((u.url.match(/^https?:\/\/([^\/]+)/i) || [])[1] || '')}</small></span></a></li>`).join('')}</ul>` : ''}
    <div class="actions">
      ${m.spotId ? `<button class="btn" type="button" data-mvguide="${esc(m.spotId)}">この場所の案内を見る</button>` : ''}
      ${m.lat && m.lng ? `<a class="btn" href="https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lng}" target="_blank" rel="noopener">地図で見る</a>` : ''}
      ${m.mine ? `<button class="btn" type="button" data-mvedit="${esc(m.memoryId)}">編集</button>` : ''}
    </div>`;
  const d = $('#dlgMemoryView'); if (!d.open) d.showModal();
}

/* --- 記録・編集 --- */
function openMemoryForm(m, preset = {}) {
  if (!state.user) { openAuth('login'); return; }
  const e = m || {};
  state.memEdit = { memoryId: e.memoryId || '', media: (e.media || []).slice(), pending: [], lat: e.lat || preset.lat || '', lng: e.lng || preset.lng || '' };
  $('#memTitle').textContent = m ? '想い出を編集' : '想い出を記録';
  $('#memTitleIn').value = e.title || '';
  $('#memDate').value = e.date || preset.date || new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  $('#memVis').value = e.visibility || 'private';
  $('#memPlace').value = e.spotName || preset.spotName || '';
  $('#memText').value = e.text || '';
  $('#memUrl').value = ''; $('#memFiles').value = '';
  $('#memPosInfo').textContent = state.memEdit.lat ? '位置を記録します' : '';
  // 場所の候補：いまの計画の行程＋案内中のスポット＋百選すべて
  const names = new Set();
  state.plan.items.forEach(i => names.add(i.name));
  if (state.guideSpot) names.add(state.guideSpot.name);
  state.spots.forEach(s => names.add(s.name));
  $('#memPlaceList').innerHTML = [...names].slice(0, 1500).map(n => `<option value="${esc(n)}"></option>`).join('');
  $('#memPlan').innerHTML = '<option value="">ひも付けない</option>' +
    state.plans.map(p => `<option value="${esc(p.planId)}" ${p.planId === (e.planId || preset.planId) ? 'selected' : ''}>${esc(p.title)}${p.date ? '（' + esc(p.date) + '）' : ''}</option>`).join('');
  $('#btnMemDelete').hidden = !m;
  $('#memProgress').hidden = true;
  $('[data-err]', $('#dlgMemory')).textContent = '';
  renderMemMedia();
  const d = $('#dlgMemory'); if (!d.open) d.showModal();
}
function renderMemMedia() {
  const me = state.memEdit;
  const saved = me.media.map((x, i) => {
    if (x.type === 'url') {
      const yt = youtubeId(x.url);
      return `<li>${yt ? `<img src="https://i.ytimg.com/vi/${yt}/default.jpg" alt="">` : ''}<span class="urlbox">🔗 ${esc(x.title || x.url)}</span>
        <button class="rm" type="button" data-rmsaved="${i}" aria-label="このURLを外す">×</button></li>`;
    }
    return `<li><img src="${driveThumb(x.fileId, 300)}" alt="" onerror="this.remove()">${x.type === 'video' ? '<span class="badge">動画</span>' : ''}
      <button class="rm" type="button" data-rmsaved="${i}" aria-label="${x.type === 'video' ? '動画' : '写真'}を外す">×</button></li>`;
  });
  const pend = me.pending.map((p, i) => `<li>${p.file.type.startsWith('video/') ? `<video src="${p.url}" muted></video><span class="badge">動画・未送信</span>` : `<img src="${p.url}" alt=""><span class="badge">未送信</span>`}
      <button class="rm" type="button" data-rmpend="${i}" aria-label="外す">×</button></li>`);
  $('#memMedia').innerHTML = saved.concat(pend).join('');
}
async function saveMemoryForm(ev) {
  ev.preventDefault();
  const me = state.memEdit, err = $('[data-err]', $('#dlgMemory')), btn = $('#btnMemSave');
  const title = $('#memTitleIn').value.trim();
  if (!title) { err.textContent = 'タイトルを入れてください'; return; }
  err.textContent = ''; busy(btn, true, '保存中…');
  try {
    // 1) 写真・動画を順にアップロード
    if (me.pending.length) {
      const bar = $('#memProgress'); bar.hidden = false;
      for (let i = 0; i < me.pending.length; i++) {
        const p = me.pending[i];
        const show = r => { $('span', bar).style.width = Math.round(r * 100) + '%'; $('em', bar).textContent = `${i + 1}/${me.pending.length}件目を送信中… ${Math.round(r * 100)}%`; };
        show(0);
        const media = await uploadMedia(p.file, show);
        me.media.push(media);
        URL.revokeObjectURL(p.url);
      }
      me.pending = []; bar.hidden = true; renderMemMedia();
    }
    // 2) 場所が百選と一致すればひも付け
    const placeName = $('#memPlace').value.trim();
    const spot = state.spots.find(s => s.name === placeName);
    const plan = state.plans.find(p => p.planId === $('#memPlan').value);
    const memory = {
      memoryId: me.memoryId, title, date: $('#memDate').value, visibility: $('#memVis').value,
      text: $('#memText').value.trim(), media: me.media,
      spotId: spot ? spot.spotId : '', spotName: placeName,
      planId: plan ? plan.planId : '', planTitle: plan ? plan.title : '',
      lat: me.lat || (spot && spot.lat) || '', lng: me.lng || (spot && spot.lng) || ''
    };
    await api('saveMemory', { memory }, { auth: true });
    $('#dlgMemory').close();
    toast('想い出を保存しました');
    loadMemories();
    if (state.guideSpot) loadSpotMemories(state.guideSpot.spotId);
  } catch (e) { err.textContent = e.message; }
  busy(btn, false);
}

function setupMemories() {
  $$('[data-mscope]').forEach(b => b.onclick = () => {
    state.memScope = b.dataset.mscope;
    $$('[data-mscope]').forEach(x => x.setAttribute('aria-selected', x === b));
    loadMemories();
  });
  $('#btnNewMemory').onclick = () => openMemoryForm(null);
  $('#btnGuideMemory').onclick = () => {
    const s = state.guideSpot;
    openMemoryForm(null, s ? { spotName: s.name, lat: s.lat, lng: s.lng } : {});
  };
  const openCard = e => { const b = e.target.closest('[data-mem]'); if (b) openMemoryView(b.dataset.mem); };
  $('#memList').addEventListener('click', e => {
    if (e.target.closest('[data-login]')) return openAuth('login');
    openCard(e);
  });
  $('#guideMemList').addEventListener('click', openCard);
  $('#memView').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.mvedit) { $('#dlgMemoryView').close(); openMemoryForm(findMemory(b.dataset.mvedit)); }
    if (b.dataset.mvguide) { $('#dlgMemoryView').close(); openGuide(b.dataset.mvguide); }
  });
  $('#memFiles').onchange = e => {
    const files = [...e.target.files];
    const max = (C.MEMORY && C.MEMORY.maxItems) || 20;
    const room = max - state.memEdit.media.length - state.memEdit.pending.length;
    if (files.length > room) toast(`1つの想い出に登録できるのは${max}件までです`);
    files.slice(0, Math.max(0, room)).forEach(f => state.memEdit.pending.push({ file: f, url: URL.createObjectURL(f) }));
    e.target.value = ''; renderMemMedia();
  };
  $('#btnMemUrl').onclick = async e => {
    const url = $('#memUrl').value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { toast('http:// か https:// で始まるURLを入れてください'); return; }
    busy(e.target, true, '確認中…');
    let info = {};
    try { info = await api('urlInfo', { url }, { auth: true }); } catch {}
    state.memEdit.media.push({ type: 'url', url, title: info.title || '', image: info.image || '' });
    $('#memUrl').value = ''; busy(e.target, false); renderMemMedia();
  };
  $('#memUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#btnMemUrl').click(); } });
  $('#memMedia').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rmsaved !== undefined) state.memEdit.media.splice(+b.dataset.rmsaved, 1);
    if (b.dataset.rmpend !== undefined) { const p = state.memEdit.pending.splice(+b.dataset.rmpend, 1)[0]; if (p) URL.revokeObjectURL(p.url); }
    renderMemMedia();
  });
  $('#btnMemHere').onclick = () => {
    if (!navigator.geolocation) { toast('この端末では現在地を取得できません'); return; }
    $('#memPosInfo').textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition(p => {
      state.memEdit.lat = Math.round(p.coords.latitude * 1e5) / 1e5; state.memEdit.lng = Math.round(p.coords.longitude * 1e5) / 1e5;
      $('#memPosInfo').textContent = '現在地を記録します';
    }, () => { $('#memPosInfo').textContent = '現在地を取得できませんでした'; }, { enableHighAccuracy: true, timeout: 15000 });
  };
  $('#formMemory').onsubmit = saveMemoryForm;
  $('#btnMemDelete').onclick = async () => {
    const id = state.memEdit.memoryId; if (!id) return;
    if (!confirm('この想い出を削除しますか？写真・動画もゴミ箱に移ります。')) return;
    try {
      await api('deleteMemory', { memoryId: id }, { auth: true });
      $('#dlgMemory').close(); toast('削除しました'); loadMemories();
      if (state.guideSpot) loadSpotMemories(state.guideSpot.spotId);
    } catch (e) { toast(e.message, 4000); }
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
  if (name === 'memory') loadMemories();
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
  setupCommon(); initMaps(); setupMics(); setupAuth(); setupSearch(); setupPlan(); setupMine(); setupGuide(); setupMemories();
  renderAccount(); renderPlan(); renderPlanList();
  loadMaster(); checkSession();
});
})();
