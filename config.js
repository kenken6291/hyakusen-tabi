/**
 * 百選たびノート 設定ファイル
 * GASを再デプロイしてURLが変わったら、ここだけ書き換えればOK。
 */
window.APP_CONFIG = {
  APP_NAME: '百選たびノート',
  VERSION: 'v1.0.0',

  // GAS ウェブアプリURL（デプロイ → ウェブアプリ のURLを貼り付け）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyzpfG7EDzgsoAquJeibBlrv6XUaJryiCCFszYn4EXfsBlWiYbywCPPOPrk4OsUmw2b8A/exec',

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

  SOURCE_URL: 'https://j100s.com/100.html'
};
