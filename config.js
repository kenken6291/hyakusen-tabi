/**
 * 百選たびノート 設定ファイル
 * GASを再デプロイしてURLが変わったら、ここだけ書き換えればOK。
 */
window.APP_CONFIG = {
  APP_NAME: '百選たびノート',
  VERSION: 'v1.11.0',

  // GAS ウェブアプリURL（デプロイ → ウェブアプリ のURLを貼り付け）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyzpfG7EDzgsoAquJeibBlrv6XUaJryiCCFszYn4EXfsBlWiYbywCPPOPrk4OsUmw2b8A/exec',

  // 既定のGeminiモデル（ユーザーが画面で選ばなかった時に使う）
  // 空文字 '' = 自動（汎用の最新モデル）
  GEMINI_MODEL: '',

  // 画面の「AIモデル」選択肢（value がAPIのモデルID）
  // 指定モデルに該当がない（廃止・未公開・名前違い）場合は
  // GAS側で汎用の最新モデルへ自動で切り替わる
  // ※ 案内文・AIアドバイスに使用。音声ガイド（TTS）は専用モデルのため対象外
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' }
  ],

  // 音声入力（途切れ防止）
  SPEECH: {
    lang: 'ja-JP',
    silenceMs: 3500,      // 話し終えてからこの時間 無音なら自動確定
    firstWaitMs: 10000,   // 何も話さない場合に待つ最大時間
    restartDelayMs: 250   // ブラウザが勝手に終了したときの再開待ち
  },

  // 音声ガイド（Gemini TTS）
  TTS: {
    voice: 'Kore',        // Gemini TTSのプリセット音声名
    chunkChars: 280       // 1回の合成で送る最大文字数（句点で分割）
  },

  // 地図
  MAP: {
    center: [36.2, 138.25],
    zoom: 5,
    walkKmh: 3.5,         // 移動時間の目安計算用
    bikeKmh: 15,
    carKmh: 40
  },

  // 想い出の記録
  MEMORY: {
    maxPhotoPx: 1920,     // 写真はこの長辺まで縮小して保存
    maxVideoMB: 100,      // 動画1本の上限（GAS側の MAX_UPLOAD_MB と合わせる）
    maxItems: 20          // 1つの想い出に付けられる写真・動画・URLの数
  },

  SOURCE_URL: 'https://j100s.com/100.html'
};
