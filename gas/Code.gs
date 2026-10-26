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
  Spots:      ['spotId','category','name','pref','lat','lng','distanceKm','durationMin','difficulty','description','videoFileId','sourceUrl','sample','updatedAt','elevation','area','geoStatus'],
  Plans:      ['planId','userId','title','date','start','mode','itemsJson','memo','createdAt','updatedAt'],
  Guides:     ['spotId','guideJson','model','createdAt']
};

/* ===================== ルーティング ===================== */
const ROUTES = {
  register, login, forgotPassword, changePassword, logout, me,
  getMaster,
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

  if (rows_('Categories').length === 0) {
    const src = 'https://j100s.com/100.html';
    [
      ['low_mountain', '日本100低山', 'main', '⛰', src, 1],
      ['cycling', '日本100サイクリングコース', 'main', '🚲', src, 2],
      ['sanpo', '日本100散歩道', 'main', '🚶', src, 3],
      ['yuhodo', '日本100遊歩道', 'main', '🌿', src, 4],
      ['meisui', '名水百選', 'other', '💧', src, 10],
      ['taki', '日本の滝百選', 'other', '🌊', src, 11],
      ['tanada', '日本の棚田百選', 'other', '🌾', src, 12],
      ['sakura', '日本さくら名所100選', 'other', '🌸', src, 13],
      ['michi', '日本の道100選', 'other', '🛣', src, 14],
      ['shinrin', '森林浴の森日本100選', 'other', '🌲', src, 15]
    ].forEach(r => append_('Categories', { categoryId: r[0], name: r[1], group: r[2], icon: r[3], sourceUrl: r[4], sort: r[5] }));
  }

  if (rows_('Spots').length === 0) {
    const now = new Date();
    // 動作確認用サンプル。sample=TRUEの行は公式リストと照合のうえ差し替えてください。
    [
      ['low_mountain', '高尾山', '東京都', 35.6251, 139.2437, 7, 180, '初級', '都心から近く、ケーブルカーも使える人気の山。薬王院への参道歩きも楽しめる。'],
      ['cycling', 'しまなみ海道', '広島県', 34.3093, 133.0950, 70, 420, '中級', '瀬戸内の島々を橋でつなぐ自転車道。海を見下ろす橋の上を走れる。'],
      ['sanpo', '鎌倉 鶴岡八幡宮かいわい', '神奈川県', 35.3259, 139.5565, 4, 120, '初級', '若宮大路から八幡宮、小町通りへ。古都の寺社と町並みを歩く。'],
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
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ userId: u.userId }), SESSION_SEC);
  return token;
}
/** allowFirst=true：初回パスワード変更前でも通す */
function auth_(token, allowFirst) {
  if (!token) throw appErr_('ログインが必要です', 'AUTH');
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) throw appErr_('ログインの有効期限が切れました。もう一度ログインしてください', 'AUTH');
  const { userId } = JSON.parse(raw);
  const u = rows_('Users').find(x => x.userId === userId);
  if (!u) throw appErr_('アカウントが見つかりません', 'AUTH');
  if (!allowFirst && isTrue_(u.isFirstLogin)) throw appErr_('先にパスワードを変更してください', 'MUST_CHANGE');
  CacheService.getScriptCache().put('sess_' + token, raw, SESSION_SEC); // 延長
  return u;
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
  const u = auth_(token, true);
  if (hash_(String(d.currentPassword || ''), u.salt) !== u.hash) throw appErr_('現在のパスワードが違います');
  if (!strongPw_(d.newPassword)) throw appErr_('8文字以上で、英字と数字を両方含めてください');
  if (d.newPassword === d.currentPassword) throw appErr_('今と違うパスワードにしてください');
  const salt = newSalt_();
  update_('Users', u._row, { salt, hash: hash_(d.newPassword, salt), isFirstLogin: false });
  return { message: 'パスワードを変更しました' };
}

function logout(d, token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return {};
}
function me(d, token) {
  const u = auth_(token, true);
  return { user: publicUser_(u), isFirstLogin: isTrue_(u.isFirstLogin) };
}

/* ===================== 百選マスター（公開） ===================== */
function getMaster() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('master_v1');
  if (hit) return JSON.parse(hit);
  const categories = rows_('Categories')
    .sort((a, b) => (+a.sort || 0) - (+b.sort || 0))
    .map(c => ({ categoryId: c.categoryId, name: c.name, group: c.group, icon: c.icon, sourceUrl: c.sourceUrl }));
  const spots = rows_('Spots').filter(s => s.spotId && s.name).map(s => ({
    spotId: String(s.spotId), category: s.category, name: s.name, pref: s.pref,
    lat: s.lat, lng: s.lng, distanceKm: s.distanceKm, durationMin: s.durationMin, difficulty: s.difficulty,
    description: s.description, videoFileId: s.videoFileId, sourceUrl: s.sourceUrl, sample: isTrue_(s.sample),
    elevation: s.elevation || '', area: s.area || ''
  }));
  const res = { categories, spots };
  const str = JSON.stringify(res);
  if (str.length < 95000) cache.put('master_v1', str, 600); // 10分キャッシュ
  return res;
}
/** スプレッドシートを編集したらこれを実行すると即反映 */
function clearMasterCache() { CacheService.getScriptCache().remove('master_v1'); }

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
  return { planId: p.planId, title: p.title, date: fmt(p.date), start: fmt(p.start) || '09:00', mode: p.mode || 'car', memo: p.memo, items };
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
    itemsJson: JSON.stringify(items), memo: String(p.memo || '').slice(0, 3000), updatedAt: new Date()
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
  const spot = rows_('Spots').find(s => String(s.spotId) === String(d.spotId));
  if (!spot) throw appErr_('スポットが見つかりません');

  const cached = rows_('Guides').find(g => String(g.spotId) === String(spot.spotId));
  if (cached && !d.refresh) {
    try { return { guide: JSON.parse(cached.guideJson), cached: true }; } catch (e) {}
  }
  const cat = rows_('Categories').find(c => c.categoryId === spot.category) || {};
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

/* ===================== 計画へのAIアドバイス ===================== */
function planAdvice(d, token) {
  auth_(token);
  const p = d.plan || {};
  const modeName = { car: '車', walk: '徒歩', bike: '自転車', transit: '公共交通' }[p.mode] || '車';
  const lines = (p.items || []).slice(0, 30).map((it, i) => `${i + 1}. ${it.name}（滞在${it.stay}分）`).join('\n');
  const prompt =
    `日帰り〜旅行の行程を確認してください。\n日付：${p.date || '未定'}　出発：${p.start || '09:00'}　移動：${modeName}\n行程：\n${lines}\n` +
    `メモ：${String(p.memo || '').slice(0, 500)}\n\n` +
    `次の観点で、具体的に短く助言してください：時間配分の無理、順番の入れ替え案、季節・天候の注意、持ち物、休憩や食事の取り方。`;
  const json = gemini_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), {
    systemInstruction: { parts: [{ text: '日本の旅行計画アドバイザー。前置きや挨拶は書かず、本題から始める。見出し記号や太字記号（#や*）は使わず、「・」の箇条書きで最大8項目、全体で500字以内。' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5 }
  });
  return { text: textOf_(json).replace(/[*#]/g, '').trim() };
}

/* ===================== 百選リストの一括登録 ===================== */
/**
 * 使い方：
 *  1) 登録したいリストを、シート名「import_カテゴリID」で取り込む（例：import_low_mountain）
 *     1行目は見出し。次の見出し名を自動で読み取ります（無い列は空でOK）：
 *       名称：山名／名称／名前／コース名／スポット名　　都道府県：所在地／都道府県
 *       エリア　標高　距離（km）　所要時間（分）　難易度　説明／概要　緯度　経度　動画ID
 *  2) importAll を実行 → Spotsへ登録（同じカテゴリ＋名称は上書き、二重登録なし）
 *     そのカテゴリのサンプル行（sample=TRUE）は削除されます。
 *  3) 続けて緯度経度の無い行を自動で位置検索します（geocodeSpots）。
 */
function importAll() {
  const book = ss_();
  const cats = rows_('Categories').map(c => String(c.categoryId));
  const targets = book.getSheets().filter(sh => /^import_/.test(sh.getName()));
  if (!targets.length) throw new Error('「import_カテゴリID」という名前のシートがありません');

  withLock_(() => {
    targets.forEach(sh => {
      const cat = sh.getName().replace(/^import_/, '');
      if (cats.indexOf(cat) < 0) { Logger.log(`スキップ：カテゴリID「${cat}」がCategoriesにありません`); return; }
      const v = sh.getDataRange().getValues();
      const head = v.shift().map(h => String(h).trim());
      const col = names => head.findIndex(h => names.some(n => h.indexOf(n) === 0));
      const ix = {
        name: col(['山名', '名称', '名前', 'コース名', 'スポット名', '遊歩道名', '散歩道名']),
        pref: col(['所在地', '都道府県']), area: col(['エリア', '地方']), elevation: col(['標高']),
        distanceKm: col(['距離']), durationMin: col(['所要時間']), difficulty: col(['難易度']),
        description: col(['説明', '概要', '紹介']), lat: col(['緯度']), lng: col(['経度']), videoFileId: col(['動画'])
      };
      if (ix.name < 0) { Logger.log(`スキップ：${sh.getName()} に名称の列がありません`); return; }

      // サンプル行の削除（下から）
      rows_('Spots').filter(s => s.category === cat && isTrue_(s.sample)).reverse()
        .forEach(s => sheet_('Spots').deleteRow(s._row));

      const existing = rows_('Spots');
      let maxId = existing.reduce((m, s) => Math.max(m, +(String(s.spotId).replace(/\D/g, '')) || 0), 0);
      let added = 0, updated = 0;
      v.forEach(r => {
        const g = k => ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '';
        const name = g('name'); if (!name) return;
        const elev = g('elevation').replace(/ｍ/g, 'm');
        const rec = {
          category: cat, name, pref: g('pref'), area: g('area'), elevation: elev,
          distanceKm: g('distanceKm').replace(/[^\d.]/g, ''), durationMin: g('durationMin').replace(/[^\d]/g, ''),
          difficulty: g('difficulty'),
          description: g('description') || [g('area') && `${g('area')}エリア`, elev && `標高${elev}`].filter(Boolean).join('、') + '。',
          sourceUrl: 'https://j100s.com/100.html', sample: false, updatedAt: new Date()
        };
        if (g('lat') && g('lng')) { rec.lat = +g('lat'); rec.lng = +g('lng'); rec.geoStatus = '手入力'; }
        if (g('videoFileId')) rec.videoFileId = g('videoFileId');
        const hit = existing.find(s => s.category === cat && s.name === name);
        if (hit) { update_('Spots', hit._row, rec); updated++; }
        else {
          rec.spotId = 'S' + String(++maxId).padStart(4, '0');
          append_('Spots', rec); added++;
        }
      });
      Logger.log(`${sh.getName()}：追加 ${added} 件／更新 ${updated} 件`);
    });
  });
  geocodeSpots();
  clearMasterCache();
}

/**
 * 緯度経度が空の行を Google Maps（GAS標準）で位置検索。
 * 検索結果の住所が「所在地」の都道府県と合わないときは登録せず、geoStatus に「要確認」と書きます。
 * 1日の検索回数に上限があるため、途中で止まったら翌日にもう一度実行してください。
 */
function geocodeSpots() {
  const geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('jp');
  const list = rows_('Spots').filter(s => !(+s.lat) || !(+s.lng));
  let ok = 0, ng = 0;
  list.forEach(s => {
    const prefs = String(s.pref || '').split(/[・、,\s]+/).filter(Boolean);
    const inner = String(s.name).match(/[（(]([^）)]+)[）)]/);
    const base = String(s.name).replace(/[（(][^）)]*[）)]/g, '').trim();
    const queries = [];
    if (inner) queries.push(`${inner[1]} ${prefs[0] || ''}`);
    queries.push(`${base} ${prefs[0] || ''}`);
    if (s.category === 'low_mountain' && !/[山岳峰]$/.test(base)) queries.push(`${base}山 ${prefs[0] || ''}`);

    let found = null;
    for (const q of queries) {
      const res = geocoder.geocode(q.trim());
      Utilities.sleep(150);
      const hit = (res.results || []).find(r => {
        const comps = (r.address_components || []).map(c => c.long_name);
        return !prefs.length || prefs.some(p => comps.indexOf(p) >= 0);
      });
      if (hit) { found = hit.geometry.location; break; }
    }
    if (found) {
      update_('Spots', s._row, { lat: Math.round(found.lat * 1e5) / 1e5, lng: Math.round(found.lng * 1e5) / 1e5, geoStatus: '自動（確認推奨）' });
      ok++;
    } else {
      update_('Spots', s._row, { geoStatus: '要確認：位置が見つかりません' });
      ng++;
    }
  });
  Logger.log(`位置検索：成功 ${ok} 件／要確認 ${ng} 件`);
  clearMasterCache();
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
