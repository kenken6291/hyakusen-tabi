/**
 * 百選たびノート GASバックエンド Code.gs
 * スクリプトプロパティ：
 *   GEMINI_API_KEY（必須） / PEPPER（setupで自動生成） / SPREADSHEET_ID（任意：未設定ならバインド先）
 *   DRIVE_FOLDER_ID（任意：TTS音声キャッシュ保存先）
 *   GEMINI_MODEL（任意：既定 gemini-2.5-flash） / GEMINI_TTS_MODEL（任意：既定 gemini-2.5-flash-preview-tts）
 *   APP_URL（任意：メール本文に載せるアプリURL）
 * コード変更後は「デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要です。
 */

const APP_NAME = '百選たびノート';
const SESSION_SEC = 21600;     // 6時間（CacheService上限）
const MAX_FAIL = 5;            // 連続失敗でロック
const LOCK_MIN = 15;
const HASH_ROUNDS = 100;

const HEADERS = {
  Users:      ['userId','email','nickname','salt','hash','isFirstLogin','failCount','lockedUntil','createdAt','lastLoginAt','role'],
  Categories: ['categoryId','name','group','icon','sourceUrl','sort'],
  Spots:      ['spotId','category','name','pref','lat','lng','distanceKm','durationMin','difficulty','description','videoFileId','sourceUrl','sample','updatedAt','elevation','area','geoStatus','base','city'],
  Plans:      ['planId','userId','title','date','start','mode','itemsJson','memo','createdAt','updatedAt','originJson','returnHome'],
  Guides:     ['spotId','guideJson','model','createdAt']
};

/* ===================== ルーティング ===================== */
const ROUTES = {
  register, login, forgotPassword, changePassword, logout, me,
  getMaster, geocode, routeTimes,
  listPlans, savePlan, deletePlan,
  generateGuide, tts, planAdvice
};

function doGet() {
  return out_({ ok: true, app: APP_NAME, time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    const fn = ROUTES[req.action];
    if (!fn) throw appErr_('不明な操作です: ' + req.action);
    const result = fn(req.data || {}, req.token || '');
    return out_(Object.assign({ ok: true }, result));
  } catch (err) {
    console.error(err && err.stack || err);
    return out_({ ok: false, error: err.message || String(err), code: err.code || '' });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function appErr_(msg, code) { const e = new Error(msg); e.code = code || ''; return e; }
function prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d || ''; }

/* ===================== シート操作 ===================== */
function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
const _checked = {};
function sheet_(name) {
  const book = ss_();
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (!_checked[name]) {
    // 列追加の自動移行：既存シートに足りない見出しを右端へ追加
    const cur = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    HEADERS[name].forEach((h, i) => {
      if (cur[i] !== h && cur.indexOf(h) < 0) sh.getRange(1, i + 1).setValue(h).setFontWeight('bold');
    });
  }
  _checked[name] = true;
  return sh;
}
function rows_(name) {
  const sh = sheet_(name);
  const v = sh.getDataRange().getValues();
  const head = v.shift();
  return v.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => o[h] = r[j]);
    return o;
  });
}
function append_(name, obj) {
  sheet_(name).appendRow(HEADERS[name].map(h => obj[h] !== undefined ? obj[h] : ''));
}
function update_(name, row, obj) {
  const sh = sheet_(name);
  const head = HEADERS[name];
  const cur = sh.getRange(row, 1, 1, head.length).getValues()[0];
  const next = head.map((h, j) => obj[h] !== undefined ? obj[h] : cur[j]);
  sh.getRange(row, 1, 1, head.length).setValues([next]);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
const isTrue_ = v => v === true || String(v).toUpperCase() === 'TRUE';

/* ===================== 初期セットアップ（手動で1回実行） ===================== */
function setup() {
  Object.keys(HEADERS).forEach(sheet_);
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());

  ensureCategories_();

  if (rows_('Spots').length === 0) {
    const now = new Date();
    // 動作確認用サンプル。sample=TRUEの行は公式リストと照合のうえ差し替えてください。
    [
      ['low_mountain', '高尾山', '東京都', 35.6251, 139.2437, 7, 180, '初級', '都心から近く、ケーブルカーも使える人気の山。薬王院への参道歩きも楽しめる。'],
      ['cycling', 'しまなみ海道', '広島県', 34.3093, 133.0950, 70, 420, '中級', '瀬戸内の島々を橋でつなぐ自転車道。海を見下ろす橋の上を走れる。'],
      ['yuhodo', '奥入瀬渓流', '青森県', 40.5560, 140.9450, 14, 300, '初級', '十和田湖から流れ出る渓流沿いの遊歩道。滝と苔むした岩が続く。'],
      ['meisui', '忍野八海', '山梨県', 35.4603, 138.8325, '', 60, '', '富士山の雪解け水が湧く八つの池。澄んだ水面に水草が揺れる。'],
      ['meisui', '柿田川湧水群', '静岡県', 35.1150, 138.9100, '', 45, '', '富士山の伏流水が湧き出す清流。展望台から湧き間を眺められる。'],
      ['taki', '華厳滝', '栃木県', 36.7385, 139.5025, '', 45, '', '中禅寺湖から落ちる落差約97mの滝。エレベーターで観瀑台へ下りられる。'],
      ['taki', '那智滝', '和歌山県', 33.6750, 135.8875, '', 60, '', '熊野那智大社の別宮・飛瀧神社のご神体とされる一段の大滝。'],
      ['tanada', '白米千枚田', '石川県', 37.3915, 136.9855, '', 40, '', '日本海に面した斜面に小さな田が幾重にも連なる能登の棚田。'],
      ['sakura', '吉野山', '奈良県', 34.3610, 135.8650, '', 240, '', '下千本から奥千本まで、山全体が桜に包まれる古来の名所。']
    ].forEach((r, i) => append_('Spots', {
      spotId: 'S' + String(i + 1).padStart(4, '0'), category: r[0], name: r[1], pref: r[2], lat: r[3], lng: r[4],
      distanceKm: r[5], durationMin: r[6], difficulty: r[7], description: r[8], videoFileId: '',
      sourceUrl: 'https://j100s.com/100.html', sample: true, updatedAt: now
    }));
  }
  clearMasterCache();
  Logger.log('セットアップ完了');
}

/* ===================== パスワード・セッション ===================== */
function hash_(password, salt) {
  let h = salt + ':' + password + ':' + prop_('PEPPER');
  for (let i = 0; i < HASH_ROUNDS; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = Utilities.base64Encode(bytes);
  }
  return h;
}
function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }
function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[(bytes[i] + 256) % chars.length];
  return s + (((bytes[11] + 256) % 8) + 2); // 末尾は必ず数字（英字+数字を保証）
}
function validEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function strongPw_(p) { return /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(p); }
function findUser_(email) {
  email = String(email || '').trim().toLowerCase();
  return rows_('Users').find(u => String(u.email).toLowerCase() === email);
}

function createSession_(u) {
  const token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  const sess = Object.assign(publicUser_(u), { isFirstLogin: isTrue_(u.isFirstLogin) });
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sess), SESSION_SEC);
  return token;
}
/** allowFirst=true：初回パスワード変更前でも通す（シートは読まずキャッシュだけで判定＝高速） */
function auth_(token, allowFirst) {
  if (!token) throw appErr_('ログインが必要です', 'AUTH');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) throw appErr_('ログインの有効期限が切れました。もう一度ログインしてください', 'AUTH');
  const sess = JSON.parse(raw);
  if (!sess.email) { // 旧形式のセッションは一度だけシートから補完
    const u = rows_('Users').find(x => x.userId === sess.userId);
    if (!u) throw appErr_('アカウントが見つかりません', 'AUTH');
    Object.assign(sess, publicUser_(u), { isFirstLogin: isTrue_(u.isFirstLogin) });
  }
  if (!allowFirst && sess.isFirstLogin) throw appErr_('先にパスワードを変更してください', 'MUST_CHANGE');
  cache.put('sess_' + token, JSON.stringify(sess), SESSION_SEC); // 延長
  return sess;
}
const publicUser_ = u => ({ userId: u.userId, email: u.email, nickname: u.nickname, role: u.role || 'member' });

function sendTempMail_(email, nickname, temp, isReset) {
  const url = prop_('APP_URL');
  const body =
    `${nickname} さん\n\n${APP_NAME} の${isReset ? 'パスワード再発行' : 'ご登録'}を受け付けました。\n\n` +
    `仮パスワード：${temp}\n\n` +
    `ログイン後、本パスワードへの変更をお願いします。\n` + (url ? `\nアプリ：${url}\n` : '') +
    `\n※このメールに心当たりがない場合は破棄してください。`;
  MailApp.sendEmail({ to: email, subject: `【${APP_NAME}】仮パスワードのお知らせ`, body });
}

/* ===================== 認証API ===================== */
function register(d) {
  const email = String(d.email || '').trim().toLowerCase();
  const nickname = String(d.nickname || '').trim().slice(0, 20);
  if (!validEmail_(email)) throw appErr_('メールアドレスの形式が正しくありません');
  if (!nickname) throw appErr_('ニックネームを入力してください');
  return withLock_(() => {
    if (findUser_(email)) throw appErr_('このメールアドレスは登録済みです。「パスワードを忘れた」から再発行できます');
    const temp = tempPassword_(), salt = newSalt_();
    append_('Users', {
      userId: 'U' + Utilities.getUuid().slice(0, 12), email, nickname, salt, hash: hash_(temp, salt),
      isFirstLogin: true, failCount: 0, lockedUntil: '', createdAt: new Date(), lastLoginAt: '', role: 'member'
    });
    sendTempMail_(email, nickname, temp, false);
    return { message: '仮パスワードをメールで送りました。届いたらログインしてください。' };
  });
}

function login(d) {
  const u = findUser_(d.email);
  const generic = 'メールアドレスまたはパスワードが違います';
  if (!u) throw appErr_(generic);
  if (u.lockedUntil && new Date(u.lockedUntil) > new Date())
    throw appErr_(`続けて失敗したため一時ロック中です。${LOCK_MIN}分ほど待つか、パスワードを再発行してください`);
  if (hash_(String(d.password || ''), u.salt) !== u.hash) {
    const n = (+u.failCount || 0) + 1;
    update_('Users', u._row, { failCount: n, lockedUntil: n >= MAX_FAIL ? new Date(Date.now() + LOCK_MIN * 60000) : '' });
    throw appErr_(n >= MAX_FAIL ? `${MAX_FAIL}回失敗したため${LOCK_MIN}分ロックしました` : `${generic}（あと${MAX_FAIL - n}回でロック）`);
  }
  update_('Users', u._row, { failCount: 0, lockedUntil: '', lastLoginAt: new Date() });
  return { token: createSession_(u), user: publicUser_(u), isFirstLogin: isTrue_(u.isFirstLogin) };
}

function forgotPassword(d) {
  const msg = '登録があれば、新しい仮パスワードをメールで送りました。';
  const u = findUser_(d.email);
  if (!u) return { message: msg }; // 登録有無は明かさない
  withLock_(() => {
    const temp = tempPassword_(), salt = newSalt_();
    update_('Users', u._row, { salt, hash: hash_(temp, salt), isFirstLogin: true, failCount: 0, lockedUntil: '' });
    sendTempMail_(u.email, u.nickname, temp, true);
  });
  return { message: msg };
}

function changePassword(d, token) {
  const sess = auth_(token, true);
  const u = rows_('Users').find(x => x.userId === sess.userId);
  if (!u) throw appErr_('アカウントが見つかりません', 'AUTH');
  if (hash_(String(d.currentPassword || ''), u.salt) !== u.hash) throw appErr_('現在のパスワードが違います');
  if (!strongPw_(d.newPassword)) throw appErr_('8文字以上で、英字と数字を両方含めてください');
  if (d.newPassword === d.currentPassword) throw appErr_('今と違うパスワードにしてください');
  const salt = newSalt_();
  update_('Users', u._row, { salt, hash: hash_(d.newPassword, salt), isFirstLogin: false });
  sess.isFirstLogin = false;
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sess), SESSION_SEC);
  return { message: 'パスワードを変更しました' };
}

function logout(d, token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return {};
}
function me(d, token) {
  const sess = auth_(token, true);
  return { user: publicUser_(sess), isFirstLogin: !!sess.isFirstLogin };
}

/* ===================== 百選マスター（公開） ===================== */
/** 大きな文字列を圧縮・分割して CacheService に保存（1件100KB制限の回避） */
function cachePutBig_(key, str, sec) {
  const b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(str, 'application/json')).getBytes());
  const size = 90000, parts = {};
  const n = Math.ceil(b64.length / size);
  for (let i = 0; i < n; i++) parts[key + '_' + i] = b64.slice(i * size, (i + 1) * size);
  parts[key + '_n'] = String(n);
  CacheService.getScriptCache().putAll(parts, sec);
}
function cacheGetBig_(key) {
  const cache = CacheService.getScriptCache();
  const n = +cache.get(key + '_n');
  if (!n) return null;
  const keys = []; for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = cache.getAll(keys);
  let b64 = '';
  for (const k of keys) { if (!got[k]) return null; b64 += got[k]; }
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip');
  return Utilities.ungzip(blob).getDataAsString('UTF-8');
}
function masterVersion_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('MASTER_VERSION');
  if (!v) { v = String(Date.now()); p.setProperty('MASTER_VERSION', v); }
  return v;
}
/** 画面に送るデータ（不要な列・空の値を省いて軽量化） */
function buildMaster_() {
  const categories = rows_('Categories')
    .sort((a, b) => (+a.sort || 0) - (+b.sort || 0))
    .map(c => ({ categoryId: String(c.categoryId), name: c.name, group: c.group, icon: c.icon }));
  const spots = rows_('Spots').filter(s => s.spotId && s.name).map(s => {
    const o = { spotId: String(s.spotId), category: s.category, name: s.name, pref: s.pref, description: s.description };
    if (+s.lat && +s.lng) { o.lat = Math.round(s.lat * 1e5) / 1e5; o.lng = Math.round(s.lng * 1e5) / 1e5; }
    ['distanceKm', 'durationMin', 'difficulty', 'elevation', 'videoFileId'].forEach(k => { if (s[k] !== '' && s[k] != null) o[k] = s[k]; });
    if (isTrue_(s.sample)) o.sample = true;
    return o;
  });
  return { categories, spots };
}
function masterData_() {
  const ver = masterVersion_();
  const hit = cacheGetBig_('master_' + ver);
  if (hit) return { ver, str: hit };
  const str = JSON.stringify(buildMaster_());
  try { cachePutBig_('master_' + ver, str, 21600); } catch (e) { console.warn(e); }
  return { ver, str };
}
/** d.version が最新と同じなら中身を返さない（画面側は手元の保存データを使う） */
function getMaster(d) {
  const ver = masterVersion_();
  if (d && d.version === ver) return { unchanged: true, version: ver };
  const m = masterData_();
  return Object.assign(JSON.parse(m.str), { version: m.ver });
}
/** スプレッドシートを編集したらこれを実行すると即反映（版番号が変わり、画面側も取り直します） */
function clearMasterCache() {
  PropertiesService.getScriptProperties().setProperty('MASTER_VERSION', String(Date.now()));
}
/** 編集したら自動で反映させたい場合：トリガー「スプレッドシートから・編集時」に onEditClearCache を登録 */
function onEditClearCache(e) {
  const name = e && e.range && e.range.getSheet().getName();
  if (name === 'Spots' || name === 'Categories') clearMasterCache();
}

/* ===================== 計画 CRUD ===================== */
function listPlans(d, token) {
  const u = auth_(token);
  const plans = rows_('Plans').filter(p => p.userId === u.userId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(planOut_);
  return { plans };
}
function planOut_(p) {
  let items = [];
  try { items = JSON.parse(p.itemsJson || '[]'); } catch (e) {}
  const fmt = v => v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', v.getFullYear() > 1900 ? 'yyyy-MM-dd' : 'HH:mm') : String(v || '');
  let origin = null;
  try { origin = p.originJson ? JSON.parse(p.originJson) : null; } catch (e) {}
  return { planId: p.planId, title: p.title, date: fmt(p.date), start: fmt(p.start) || '09:00', mode: p.mode || 'car', memo: p.memo, items,
    origin, returnHome: p.returnHome === '' ? true : isTrue_(p.returnHome) };
}
function savePlan(d, token) {
  const u = auth_(token);
  const p = d.plan || {};
  const title = String(p.title || '').trim().slice(0, 60);
  if (!title) throw appErr_('計画の名前を入れてください');
  const items = (p.items || []).slice(0, 50).map(it => ({
    type: it.type === 'custom' ? 'custom' : 'spot', spotId: String(it.spotId || ''),
    name: String(it.name || '').slice(0, 60), lat: +it.lat || '', lng: +it.lng || '',
    stay: Math.max(0, Math.min(1440, +it.stay || 0)), note: String(it.note || '').slice(0, 300)
  }));
  const rec = {
    title, date: "'" + String(p.date || ''), start: "'" + String(p.start || '09:00'),
    mode: ['car', 'walk', 'bike', 'transit'].indexOf(p.mode) >= 0 ? p.mode : 'car',
    itemsJson: JSON.stringify(items), memo: String(p.memo || '').slice(0, 3000), updatedAt: new Date(),
    originJson: p.origin && p.origin.name ? JSON.stringify({ name: String(p.origin.name).slice(0, 80), lat: +p.origin.lat || '', lng: +p.origin.lng || '' }) : '',
    returnHome: p.returnHome !== false
  };
  return withLock_(() => {
    if (p.planId) {
      const row = rows_('Plans').find(x => x.planId === p.planId);
      if (!row || row.userId !== u.userId) throw appErr_('この計画は編集できません');
      update_('Plans', row._row, rec);
      return { planId: p.planId };
    }
    const planId = 'P' + Utilities.getUuid().slice(0, 12);
    append_('Plans', Object.assign({ planId, userId: u.userId, createdAt: new Date() }, rec));
    return { planId };
  });
}
function deletePlan(d, token) {
  const u = auth_(token);
  return withLock_(() => {
    const row = rows_('Plans').find(x => x.planId === d.planId);
    if (!row || row.userId !== u.userId) throw appErr_('この計画は削除できません');
    sheet_('Plans').deleteRow(row._row);
    return {};
  });
}

/* ===================== Gemini 共通 ===================== */
function gemini_(model, payload) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw appErr_('GEMINI_API_KEY が設定されていません（スクリプトプロパティ）');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * (attempt + 1)); continue; }
    throw appErr_('Gemini APIエラー(' + code + '): ' + res.getContentText().slice(0, 200));
  }
  throw appErr_('Gemini APIが混み合っています。少し待ってからお試しください');
}
function textOf_(json) {
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

/**
 * ナレーションの清掃（二重の安全装置）
 * システムプロンプトで禁止したうえで、万一混入した前置き・メタ指示・記号を除去する。
 */
function sanitizeNarration_(t) {
  let s = String(t || '').replace(/\r/g, '');
  s = s.replace(/[*#_`>~|]/g, '').replace(/^[\s・\-–—]+/gm, '');
  s = s.replace(/[（(][^）)]*(読み上げ|ナレーション|間を|ゆっくり|BGM|効果音|SE)[^）)]*[）)]/g, '');
  s = s.replace(/【[^】]*】/g, '').replace(/^\s*(ナレーション|ナレーター|案内文|原稿)\s*[:：]\s*/gm, '');
  const metaHead = /^(はい|承知|かしこまり|了解|分かりました|わかりました|以下|それでは|では、?以下|こちらが|お任せ)[^。！\n]*[。！：:\n]\s*/;
  for (let i = 0; i < 3; i++) s = s.replace(metaHead, '');
  s = s.split(/\n+/).filter(l => !/(読み上げてください|読み上げます|案内文です|ナレーションです|いかがでしょうか|ご要望|お役に立て)/.test(l)).join('');
  s = s.replace(/[「」『』"]/g, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

/* ===================== 案内文生成 ===================== */
const GUIDE_SYSTEM = [
  'あなたは日本の旅行ガイド原稿を書く専門ライターです。',
  '出力は指定のJSONスキーマに厳密に従い、JSON以外の文字は一切出力しません。',
  'narration は音声合成（TTS）にそのまま渡す読み上げ本文です。次を絶対に守ること：',
  '・挨拶、前置き、返事（例：「はい」「承知しました」「以下が案内文です」）を書かない。',
  '・「〜で読み上げてください」「ゆっくりと」などの読み方の指示、ト書き、括弧書きの演出指示を書かない。',
  '・見出し、箇条書き、記号（*,#,-,・）、絵文字、URL、ふりがな括弧を書かない。',
  '・聞き手に直接語りかける自然な話し言葉（です・ます調）の地の文のみで、350〜550字。',
  '・難読の地名は読みやすい表記にする。',
  '内容は事実に基づき、不確かな数値や年代は断定せず「〜といわれます」等で表現する。',
  'cautions には現地での安全上の注意（足元、天候、熊・蜂、熱中症、増水、通行規制の確認など該当するもの）を具体的に書く。'
].join('\n');

function generateGuide(d, token) {
  auth_(token);
  const master = JSON.parse(masterData_().str);
  const spot = master.spots.find(s => String(s.spotId) === String(d.spotId));
  if (!spot) throw appErr_('スポットが見つかりません');
  const cache = CacheService.getScriptCache();
  const ckey = 'guide_' + spot.spotId;

  if (!d.refresh) {
    const hitC = cache.get(ckey);
    if (hitC) return { guide: JSON.parse(hitC), cached: true };
    const cell = sheet_('Guides').getRange('A:A').createTextFinder(String(spot.spotId)).matchEntireCell(true).findNext();
    if (cell) {
      try {
        const json = sheet_('Guides').getRange(cell.getRow(), 2).getValue();
        const g = JSON.parse(json);
        if (json.length < 90000) cache.put(ckey, json, 21600);
        return { guide: g, cached: true };
      } catch (e) {}
    }
  }
  const cat = master.categories.find(c => c.categoryId === spot.category) || {};
  const model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
  const userText =
    `スポット名：${spot.name}\n分類：${cat.name || spot.category}\n所在地：${spot.pref}\n` +
    (spot.distanceKm ? `距離：約${spot.distanceKm}km\n` : '') + (spot.durationMin ? `所要時間の目安：${spot.durationMin}分\n` : '') +
    (spot.difficulty ? `難易度：${spot.difficulty}\n` : '') + (spot.elevation ? `標高：${spot.elevation}\n` : '') + `概要：${spot.description}\n\n上記スポットの案内を作成してください。`;

  const json = gemini_(model, {
    systemInstruction: { parts: [{ text: GUIDE_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          history: { type: 'STRING' },
          highlights: { type: 'ARRAY', items: { type: 'STRING' } },
          bestSeason: { type: 'STRING' },
          cautions: { type: 'ARRAY', items: { type: 'STRING' } },
          narration: { type: 'STRING' }
        },
        required: ['history', 'highlights', 'bestSeason', 'cautions', 'narration']
      }
    }
  });
  let g;
  try { g = JSON.parse(textOf_(json)); } catch (e) { throw appErr_('解説の作成に失敗しました。もう一度お試しください'); }
  g.narration = sanitizeNarration_(g.narration);
  if (!g.narration) throw appErr_('読み上げ原稿が空でした。もう一度お試しください');

  withLock_(() => {
    const row = rows_('Guides').find(x => String(x.spotId) === String(spot.spotId));
    const rec = { spotId: spot.spotId, guideJson: JSON.stringify(g), model, createdAt: new Date() };
    if (row) update_('Guides', row._row, rec); else append_('Guides', rec);
  });
  cache.put(ckey, JSON.stringify(g), 21600);
  return { guide: g, cached: false };
}

/* ===================== Gemini TTS ===================== */
/**
 * 渡されたテキストだけを合成する。プロンプト・指示文は一切付けない。
 * 戻り値：WAV(Base64)。DRIVE_FOLDER_ID があればDriveへキャッシュ。
 */
function tts(d, token) {
  auth_(token);
  const text = sanitizeNarration_(d.text).slice(0, 600);
  if (!text) throw appErr_('読み上げる文章がありません');
  const voice = String(d.voice || 'Kore').replace(/[^A-Za-z]/g, '');
  const model = prop_('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');

  const key = md5_(model + '|' + voice + '|' + text);
  const folderId = prop_('DRIVE_FOLDER_ID');
  let folder = null;
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
    const it = folder.getFilesByName('tts_' + key + '.wav');
    if (it.hasNext()) return { audio: Utilities.base64Encode(it.next().getBlob().getBytes()), cached: true };
  }

  let pcm = null;
  for (let i = 0; i < 2 && !pcm; i++) {
    const json = gemini_(model, {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    });
    const part = ((((json.candidates || [])[0] || {}).content || {}).parts || []).find(p => p.inlineData);
    if (part) pcm = Utilities.base64Decode(part.inlineData.data);
  }
  if (!pcm) throw appErr_('音声の合成に失敗しました');

  const wav = pcmToWav_(pcm, 24000, 1, 16);
  if (folder) folder.createFile(Utilities.newBlob(wav, 'audio/wav', 'tts_' + key + '.wav'));
  return { audio: Utilities.base64Encode(wav), cached: false };
}

function md5_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
/** 生PCM(s16le) → WAV */
function pcmToWav_(pcm, rate, ch, bits) {
  const blockAlign = ch * bits / 8, byteRate = rate * blockAlign, len = pcm.length;
  const h = [];
  const str = s => { for (let i = 0; i < s.length; i++) h.push(s.charCodeAt(i)); };
  const u32 = n => h.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255);
  const u16 = n => h.push(n & 255, (n >> 8) & 255);
  str('RIFF'); u32(36 + len); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(ch); u32(rate); u32(byteRate); u16(blockAlign); u16(bits);
  str('data'); u32(len);
  const head = h.map(b => (b > 127 ? b - 256 : b));
  return head.concat(Array.prototype.slice.call(pcm));
}

/* ===================== 出発地の検索 ===================== */
/** 地名・駅名・住所 → 候補（最大5件）。同じ語は6時間キャッシュ */
function geocode(d) {
  const q = String(d.query || '').normalize('NFKC').trim().slice(0, 100);
  if (!q) throw appErr_('出発地を入力してください');
  const cache = CacheService.getScriptCache();
  const key = 'geo_' + md5_(q);
  const hit = cache.get(key);
  if (hit) return { results: JSON.parse(hit) };
  const res = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(q);
  const results = (res.results || []).slice(0, 5).map(r => ({
    name: String(r.formatted_address || q).replace(/^日本、\s*/, '').replace(/〒\d{3}-\d{4}\s*/, ''),
    lat: Math.round(r.geometry.location.lat * 1e5) / 1e5,
    lng: Math.round(r.geometry.location.lng * 1e5) / 1e5
  }));
  cache.put(key, JSON.stringify(results), 21600);
  return { results };
}

/* ===================== 経路の所要時間 ===================== */
const ROUTE_MODES = { car: 'DRIVING', walk: 'WALKING', bike: 'BICYCLING', transit: 'TRANSIT' };

/** 「YYYY-MM-DD」「HH:MM」→ 日本時間の Date */
function jstDate_(date, hm) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const t = /^\d{1,2}:\d{2}$/.test(hm || '') ? hm.padStart(5, '0') : '09:00';
  return new Date(`${d}T${t}:00+09:00`);
}

/** 名称＋都道府県から位置を探す（都道府県が合う結果のみ） */
function geocodeOne_(name, pref) {
  const q = `${norm_(name).replace(/[（(][^）)]*[）)]/g, '')} ${norm_(pref).split(/[・、\s]/)[0]}`.trim();
  const cache = CacheService.getScriptCache();
  const key = 'g1_' + md5_(q);
  const hit = cache.get(key);
  if (hit) return hit === 'none' ? null : JSON.parse(hit);
  let out = null;
  try {
    const res = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(q);
    const prefs = norm_(pref).split(/[・、,\s]+/).filter(Boolean);
    const r = (res.results || []).find(x => !prefs.length || (x.address_components || []).some(c => prefs.indexOf(c.long_name) >= 0));
    if (r) out = { lat: Math.round(r.geometry.location.lat * 1e5) / 1e5, lng: Math.round(r.geometry.location.lng * 1e5) / 1e5 };
  } catch (e) { console.warn(e); }
  cache.put(key, out ? JSON.stringify(out) : 'none', 21600);
  return out;
}

/** 2地点間の所要時間。Googleの経路検索 → だめなら車の時間から推定 → 直線距離から目安 */
function directions_(from, to, mode, depart) {
  const r3 = v => Math.round(+v * 1000) / 1000;
  const hour = Utilities.formatDate(depart, 'Asia/Tokyo', 'yyyyMMddHH');
  const key = 'rt_' + md5_([mode, r3(from.lat), r3(from.lng), r3(to.lat), r3(to.lng), (mode === 'transit' || mode === 'car') ? hour : ''].join('|'));
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const ask = m => {
    try {
      const df = Maps.newDirectionFinder()
        .setOrigin(+from.lat, +from.lng).setDestination(+to.lat, +to.lng)
        .setMode(Maps.DirectionFinder.Mode[ROUTE_MODES[m]]).setLanguage('ja').setRegion('jp');
      if ((m === 'transit' || m === 'car') && depart.getTime() > Date.now()) df.setDepart(depart);
      const res = df.getDirections();
      if (res.status !== 'OK' || !res.routes.length) return null;
      const leg = res.routes[0].legs[0];
      let summary = '';
      if (m === 'transit') {
        summary = (leg.steps || []).filter(s => s.travel_mode === 'TRANSIT')
          .map(s => { const l = (s.transit_details || {}).line || {}; return l.short_name || l.name || ''; })
          .filter(Boolean).join('→');
      }
      return { minutes: Math.max(1, Math.round(leg.duration.value / 60)), km: Math.round(leg.distance.value / 100) / 10, summary };
    } catch (e) { console.warn(e); return null; }
  };

  let out = ask(mode);
  if (out) out.source = 'google';
  if (!out && mode !== 'car') {
    const car = ask('car');
    if (car) {
      const minutes = mode === 'transit' ? Math.round(car.minutes * 1.3 + 15)
        : mode === 'bike' ? Math.round(car.km / 15 * 60)
        : Math.round(car.km / 4 * 60);
      out = { minutes, km: car.km, summary: '', source: 'estimate' };
    }
  }
  if (!out) {
    const R = 6371, rad = Math.PI / 180;
    const x = Math.sin((to.lat - from.lat) * rad / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin((to.lng - from.lng) * rad / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(x)) * 1.3;
    const kmh = { car: 40, walk: 3.5, bike: 15, transit: 30 }[mode];
    out = { minutes: Math.round(km / kmh * 60), km: Math.round(km * 10) / 10, summary: '', source: 'line' };
  }
  cache.put(key, JSON.stringify(out), 21600);
  return out;
}

/**
 * 行程全体の所要時間を、出発時刻から順に計算。
 * d: { mode, date, start, points:[{name, pref, lat, lng, stay, custom}] }
 * 位置のない立ち寄り（custom）は、直前の場所に滞在したものとして扱う。
 */
function routeTimes(d) {
  const mode = ROUTE_MODES[d.mode] ? d.mode : 'car';
  const pts = (d.points || []).slice(0, 15).map(p => ({
    name: String(p.name || '').slice(0, 80), pref: String(p.pref || '').slice(0, 30),
    lat: +p.lat || 0, lng: +p.lng || 0, stay: Math.max(0, Math.min(1440, +p.stay || 0)), custom: !!p.custom
  }));
  pts.forEach(p => {
    if (!(p.lat && p.lng) && !p.custom && p.name) {
      const g = geocodeOne_(p.name, p.pref);
      if (g) { p.lat = g.lat; p.lng = g.lng; p.geocoded = true; }
    }
  });
  let t = jstDate_(d.date, d.start).getTime();
  let last = pts[0] && pts[0].lat ? pts[0] : null;
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const to = pts[i];
    let leg;
    if (to.custom && !to.lat) leg = { minutes: 0, source: 'custom' };
    else if (!last || !to.lat) leg = { minutes: null, source: 'none' };
    else leg = directions_(last, to, mode, new Date(t));
    legs.push(leg);
    t += ((leg.minutes || 0) + to.stay) * 60000;
    if (to.lat) last = to;
  }
  return { legs, points: pts.map(p => p.lat ? { lat: p.lat, lng: p.lng, geocoded: !!p.geocoded } : null) };
}

/* ===================== 計画へのAIアドバイス ===================== */
function planAdvice(d, token) {
  auth_(token);
  const p = d.plan || {};
  const modeName = { car: '車', walk: '徒歩', bike: '自転車', transit: '公共交通' }[p.mode] || '車';
  const lines = (p.items || []).slice(0, 30).map((it, i) => `${i + 1}. ${it.name}（滞在${it.stay}分）`).join('\n');
  const from = p.origin && p.origin.name ? String(p.origin.name).slice(0, 80) : '未設定';
  const prompt =
    `日帰り〜旅行の行程を確認してください。\n日付：${p.date || '未定'}　出発時刻：${p.start || '09:00'}　移動：${modeName}\n` +
    `出発地：${from}${p.returnHome !== false && from !== '未設定' ? '（最後は出発地へ戻る）' : ''}\n行程：\n${lines}\n` +
    (d.schedule ? `時刻表（経路検索の所要時間を反映済み）：\n${String(d.schedule).slice(0, 2000)}\n` : '') +
    `メモ：${String(p.memo || '').slice(0, 500)}\n\n` +
    `次の観点で、具体的に短く助言してください：移動時間を踏まえた時間配分の無理（出発時刻の前倒し・後ろ倒しの提案を含む）、順番の入れ替え案、季節・天候の注意、持ち物、休憩や食事の取り方。`;
  const json = gemini_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), {
    systemInstruction: { parts: [{ text: '日本の旅行計画アドバイザー。前置きや挨拶は書かず、本題から始める。見出し記号や太字記号（#や*）は使わず、「・」の箇条書きで最大8項目、全体で500字以内。' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5 }
  });
  return { text: textOf_(json).replace(/[*#]/g, '').trim() };
}

/* ===================== カテゴリ管理 ===================== */
const SRC_URL = 'https://j100s.com/100.html';
const DEFAULT_CATEGORIES = [
  ['low_mountain', '日本100低山', 'main', '⛰', 1],
  ['cycling', '日本100サイクリングコース', 'main', '🚲', 2],
  ['yuhodo', '日本100遊歩道', 'main', '🌿', 4],
  ['meisui', '名水百選', 'other', '💧', 10],
  ['taki', '日本の滝百選', 'other', '🌊', 11],
  ['tanada', '日本の棚田百選', 'other', '🌾', 12],
  ['sakura', '日本さくら名所100選', 'other', '🌸', 13],
  ['koyo', '日本の紅葉名所100選', 'other', '🍁', 14],
  ['michi', '日本の道100選', 'other', '🛣', 15],
  ['shinrin', '森林浴の森日本100選', 'other', '🌲', 16]
];
const REMOVED_CATEGORIES = ['sanpo']; // 日本100散歩道は廃止

/** 足りないカテゴリを追加し、廃止カテゴリとそのスポット・解説を削除（何度実行しても安全） */
function ensureCategories_() {
  const have = rows_('Categories').map(c => String(c.categoryId));
  DEFAULT_CATEGORIES.forEach(r => {
    if (have.indexOf(r[0]) < 0) append_('Categories', { categoryId: r[0], name: r[1], group: r[2], icon: r[3], sourceUrl: SRC_URL, sort: r[4] });
  });
  rows_('Categories').filter(c => REMOVED_CATEGORIES.indexOf(String(c.categoryId)) >= 0).reverse()
    .forEach(c => sheet_('Categories').deleteRow(c._row));

  const spots = rows_('Spots');
  const removed = spots.filter(s => REMOVED_CATEGORIES.indexOf(String(s.category)) >= 0);
  if (removed.length) {
    const ids = removed.map(s => String(s.spotId));
    removed.reverse().forEach(s => sheet_('Spots').deleteRow(s._row));
    rows_('Guides').filter(g => ids.indexOf(String(g.spotId)) >= 0).reverse()
      .forEach(g => sheet_('Guides').deleteRow(g._row));
    Logger.log(`廃止カテゴリのスポットを ${removed.length} 件削除しました`);
  }
}

/* ===================== 百選リストの一括登録 ===================== */
/**
 * 使い方：
 *  1) 登録したいリストを、このスプレッドシートに「新しいシート」として取り込む
 *     シート名は「import_カテゴリID」か、リスト名そのまま（「低山」「滝」などの語で自動判定）。
 *     見出し行は1行目でなくても自動で探します。
 *  2) importAll を実行 → Spotsへ登録（同じカテゴリ＋名称＋都道府県は上書き、二重登録なし）
 *     そのカテゴリのサンプル行（sample=TRUE）は削除されます。
 *  3) 続けて緯度経度の無い行を自動で位置検索します（件数が多いときは1分後に自動で続きを実行）。
 */
const CATEGORY_KEYWORDS = {
  low_mountain: ['低山'], cycling: ['サイクリング', '自転車'], yuhodo: ['遊歩道', '遊歩'],
  meisui: ['名水'], taki: ['滝'], tanada: ['棚田'], sakura: ['さくら', '桜'], koyo: ['紅葉'],
  michi: ['道100', '道百', '道の100', '_michi'], shinrin: ['森林']
};
const COLS = {
  name: ['山名', 'コース名', 'スポット名', '遊歩道名', '散歩道名', '名称', '名前', '滝名', '施設名', '棚田名', '森林名'],
  pref: ['都道府県', '所在地'], city: ['市町村', '自治体'], area: ['エリア', '地方'], elevation: ['標高'],
  distanceKm: ['距離'], durationMin: ['所要時間'], difficulty: ['難易度'],
  description: ['説明', '概要', '紹介', '特徴', '見どころ'], terrain: ['地形', '起伏'], scenery: ['景観'],
  base: ['拠点', 'レンタサイクル'], lat: ['緯度'], lng: ['経度'], videoFileId: ['動画']
};
const norm_ = v => String(v == null ? '' : v).normalize('NFKC').trim();
const spotKey_ = (cat, name, pref) => [cat, norm_(name), norm_(pref).split(/[・、,\/\s]+/)[0]].join('|');

function detectCategory_(sheetName, catIds) {
  const n = norm_(sheetName);
  if (/集計|サマリー|概要|summary/i.test(n)) return '';
  const m = n.match(/^import[\s_\-]*(.+)$/i);
  if (m && catIds.indexOf(m[1].trim()) >= 0) return m[1].trim();
  for (const id in CATEGORY_KEYWORDS) {
    if (catIds.indexOf(id) >= 0 && CATEGORY_KEYWORDS[id].some(k => n.indexOf(k) >= 0)) return id;
  }
  return '';
}

function findHeader_(values) {
  for (let i = 0; i < Math.min(values.length, 15); i++) {
    const head = values[i].map(norm_);
    if (head.some(h => COLS.name.some(k => h.indexOf(k) >= 0))) return i;
  }
  return -1;
}

/** Spots を丸ごと読み書き（大量件数でも速い） */
function readSpots_() {
  const sh = sheet_('Spots');
  const n = HEADERS.Spots.length;
  const last = sh.getLastRow();
  const v = last > 1 ? sh.getRange(2, 1, last - 1, n).getValues() : [];
  return v.map(r => { const o = {}; HEADERS.Spots.forEach((h, j) => o[h] = r[j]); return o; });
}
function writeSpots_(list) {
  const sh = sheet_('Spots');
  const n = HEADERS.Spots.length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, n).clearContent();
  if (list.length) sh.getRange(2, 1, list.length, n).setValues(list.map(o => HEADERS.Spots.map(h => o[h] == null ? '' : o[h])));
  if (sh.getLastRow() > list.length + 1) sh.deleteRows(list.length + 2, sh.getLastRow() - list.length - 1);
}

function importAll() {
  ensureCategories_();
  const book = ss_();
  const catIds = rows_('Categories').map(c => String(c.categoryId));
  const system = Object.keys(HEADERS);
  const targets = book.getSheets().filter(sh => system.indexOf(sh.getName()) < 0)
    .map(sh => ({ sh, cat: detectCategory_(sh.getName(), catIds) })).filter(t => t.cat);
  if (!targets.length) {
    throw new Error(
      '取り込むリストのシートが見つかりません。\n' +
      '対象スプレッドシート：「' + book.getName() + '」 ' + book.getUrl() + '\n' +
      'このスプレッドシート内のシート：' + book.getSheets().map(x => '「' + x.getName() + '」').join(' ') + '\n' +
      'リストを上のスプレッドシートに「新しいシート」として取り込んでから、もう一度実行してください。');
  }

  withLock_(() => {
    let spots = readSpots_();
    const index = {};
    spots.forEach((s, i) => index[spotKey_(s.category, s.name, s.pref)] = i);
    let maxId = spots.reduce((m, s) => Math.max(m, +(String(s.spotId).replace(/\D/g, '')) || 0), 0);
    const doneCats = {};

    targets.forEach(({ sh, cat }) => {
      const v = sh.getDataRange().getValues();
      const hr = findHeader_(v);
      if (hr < 0) { Logger.log(`スキップ：「${sh.getName()}」に名称の列が見つかりません`); return; }
      const head = v[hr].map(norm_);
      const ix = {};
      Object.keys(COLS).forEach(k => ix[k] = head.findIndex(h => COLS[k].some(w => h.indexOf(w) >= 0)));
      if (ix.name === ix.description) ix.description = -1;
      if (ix.pref === ix.city) ix.city = -1;

      if (!doneCats[cat]) { // サンプル行を除外（1カテゴリ1回）
        spots = spots.filter(s => !(s.category === cat && isTrue_(s.sample)));
        Object.keys(index).forEach(k => delete index[k]);
        spots.forEach((s, i) => index[spotKey_(s.category, s.name, s.pref)] = i);
        doneCats[cat] = true;
      }

      let added = 0, updated = 0;
      v.slice(hr + 1).forEach(r => {
        const g = k => ix[k] >= 0 ? norm_(r[ix[k]]) : '';
        const name = g('name'); if (!name) return;
        const elev = g('elevation');
        const desc = [
          g('description') || [g('area') && `${g('area')}エリア`, elev && `標高${elev}`].filter(Boolean).join('、') + '。',
          g('terrain') && `地形：${g('terrain')}。`, g('scenery') && `景観：${g('scenery')}。`, g('base') && `拠点：${g('base')}。`
        ].filter(Boolean).join(' ');
        const rec = {
          category: cat, name, pref: g('pref'), city: g('city'), area: g('area'), elevation: elev, base: g('base'),
          distanceKm: g('distanceKm').replace(/[^\d.]/g, ''), durationMin: g('durationMin').replace(/[^\d]/g, ''),
          difficulty: g('difficulty'), description: desc, sourceUrl: SRC_URL, sample: false, updatedAt: new Date()
        };
        if (+g('lat') && +g('lng')) { rec.lat = +g('lat'); rec.lng = +g('lng'); rec.geoStatus = '手入力'; }
        if (g('videoFileId')) rec.videoFileId = g('videoFileId');
        const key = spotKey_(cat, name, rec.pref);
        if (index[key] !== undefined) {
          const cur = spots[index[key]];
          Object.keys(rec).forEach(k => { if (rec[k] !== '' || k === 'description') cur[k] = rec[k]; });
          updated++;
        } else {
          rec.spotId = 'S' + String(++maxId).padStart(4, '0');
          index[key] = spots.push(rec) - 1; added++;
        }
      });
      Logger.log(`「${sh.getName()}」→ ${cat}：追加 ${added} 件／更新 ${updated} 件`);
    });
    writeSpots_(spots);
  });
  clearMasterCache();
  geocodeSpots();
}

/**
 * 緯度経度が空の行を Google Maps（GAS標準）で位置検索。
 * 検索結果の住所が都道府県と合わないものは登録せず「要確認」にします（要確認の行は再検索しません）。
 * 約4分で区切り、残りがあれば1分後に自動で続きを実行します。
 * 1日の検索上限に達したら、翌日に自動で再開します。
 */
function geocodeSpots() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'geocodeSpots')
    .forEach(t => ScriptApp.deleteTrigger(t));
  const started = Date.now();
  const geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('jp');
  const spots = readSpots_();
  const todo = spots.filter(s => (!(+s.lat) || !(+s.lng)) && !/^要確認/.test(String(s.geoStatus)));
  let ok = 0, ng = 0, stopped = '';

  for (const s of todo) {
    if (Date.now() - started > 4 * 60 * 1000) { stopped = 'time'; break; }
    const prefs = norm_(s.pref).split(/[・、,\/\s]+/).filter(Boolean);
    const p0 = prefs[0] || '';
    const city = norm_(s.city).replace(/[（(][^）)]*[）)]/g, '').split(/[・、～〜\/]/)[0].trim();
    const name = norm_(s.name);
    const inner = name.match(/[（(]([^）)]+)[）)]/);
    const base = name.replace(/[（(][^）)]*[）)]/g, '').trim();
    const queries = [];
    if (s.base) {
      const b = norm_(s.base).split(/[・、,\/]/)[0].replace(/(前|周辺|に多数|等の各拠点|等|など|に拠点多数|各所).*$/, '').trim();
      if (b) queries.push(`${b} ${p0}`);
    }
    if (city) queries.push(`${base} ${p0}${city}`);
    if (inner) queries.push(`${inner[1]} ${p0}`);
    queries.push(`${base} ${p0}`);
    base.split(/[・、]/).map(x => x.trim()).filter(x => x && x !== base).forEach(x => queries.push(`${x} ${p0}`));
    if (s.category === 'low_mountain' && !/[山岳峰]$/.test(base)) queries.push(`${base}山 ${p0}`);

    let found = null;
    try {
      for (const q of queries) {
        const res = geocoder.geocode(q.trim());
        Utilities.sleep(120);
        const hit = (res.results || []).find(r => {
          const comps = (r.address_components || []).map(c => c.long_name);
          return !prefs.length || prefs.some(p => comps.indexOf(p) >= 0);
        });
        if (hit) { found = hit.geometry.location; break; }
      }
    } catch (e) {
      if (/too many times|上限|quota/i.test(String(e))) { stopped = 'quota'; break; }
      throw e;
    }
    if (found) {
      s.lat = Math.round(found.lat * 1e5) / 1e5; s.lng = Math.round(found.lng * 1e5) / 1e5;
      s.geoStatus = '自動（確認推奨）'; ok++;
    } else { s.geoStatus = '要確認：位置が見つかりません'; ng++; }
  }

  withLock_(() => {
    // 実行中に他で書き換えられた行を壊さないよう、位置情報だけを最新データへ反映
    const latest = readSpots_();
    const byId = {}; spots.forEach(s => byId[s.spotId] = s);
    latest.forEach(s => {
      const m = byId[s.spotId];
      if (m && !(+s.lat) && m.geoStatus) { s.lat = m.lat; s.lng = m.lng; s.geoStatus = m.geoStatus; }
    });
    writeSpots_(latest);
  });
  clearMasterCache();

  const rest = todo.length - ok - ng;
  Logger.log(`位置検索：成功 ${ok} 件／要確認 ${ng} 件／残り ${rest} 件`);
  if (stopped === 'time' && rest > 0) {
    ScriptApp.newTrigger('geocodeSpots').timeBased().after(60 * 1000).create();
    Logger.log('残りは1分後に自動で続けます');
  } else if (stopped === 'quota') {
    ScriptApp.newTrigger('geocodeSpots').timeBased().after(24 * 60 * 60 * 1000).create();
    Logger.log('本日の検索上限に達しました。24時間後に自動で再開します');
  }
}

/** 「要確認」の行をもう一度位置検索したいとき */
function retryGeocode() {
  const spots = readSpots_();
  spots.forEach(s => { if (/^要確認/.test(String(s.geoStatus))) s.geoStatus = ''; });
  writeSpots_(spots);
  geocodeSpots();
}

/* ===================== 動作テスト（エディタから実行） ===================== */
function testGemini() {
  const r = gemini_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), { contents: [{ role: 'user', parts: [{ text: '「こんにちは」とだけ返して' }] }] });
  Logger.log(textOf_(r));
}
function testTts() {
  const model = prop_('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const json = gemini_(model, {
    contents: [{ role: 'user', parts: [{ text: 'ようこそ、百選たびノートへ。' }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
  });
  Logger.log(JSON.stringify(json).slice(0, 300));
}
