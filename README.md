# 百選たびノート（hyakusen-tabi）

日本100低山・日本100サイクリングコース・日本100散歩道・日本100遊歩道、ほか日本百選（[日本百選一覧](https://j100s.com/100.html)）から行き先を選び、計画づくりから現地での音声ガイド・紹介動画までをまとめたWebアプリです。

## ファイル構成

| ファイル | 置き場所 | 役割 |
|---|---|---|
| `index.html` | GitHub Pages | 画面・スタイル・モーダル（認証／パスワード変更／使い方） |
| `config.js` | GitHub Pages | GAS URL・バージョン・音声入力/TTS/地図の設定 |
| `app.js` | GitHub Pages | 画面制御、途切れない音声入力、計画、案内・TTS再生、認証フロー |
| `Code.gs` | Google Apps Script | スプレッドシートCRUD、パスワードハッシュ、仮パスワード、Gemini/TTS |

---

## 1. スプレッドシートとGASの準備

1. Googleスプレッドシートを新規作成（名前例：`hyakusen-tabi-db`）。
2. 拡張機能 → Apps Script を開き、`Code.gs` の中身を貼り付けて保存。
3. プロジェクトの設定 → **スクリプトプロパティ** に追加：

| キー | 必須 | 内容 |
|---|---|---|
| `GEMINI_API_KEY` | ○ | Google AI Studio で発行したAPIキー |
| `DRIVE_FOLDER_ID` | 任意 | TTS音声キャッシュ用のDriveフォルダID（同じ文章の再合成を防ぎ、API利用量を節約） |
| `GEMINI_MODEL` | 任意 | 案内文用モデル（既定：`gemini-2.5-flash`） |
| `GEMINI_TTS_MODEL` | 任意 | 音声合成用モデル（既定：`gemini-2.5-flash-preview-tts`） |
| `APP_URL` | 任意 | メール本文に載せるURL（例：`https://kenken6291.github.io/hyakusen-tabi/`） |
| `SPREADSHEET_ID` | 任意 | スタンドアロンGASにする場合のみ |
| `PEPPER` | 自動 | `setup` 実行時に自動生成。**後から変えると全員ログインできなくなる**ので触らない |

4. エディタで関数 `setup` を選んで実行 → 権限を承認。シートと初期データが作られます。
5. `testGemini` と `testTts` を実行し、ログにエラーが出ないことを確認。
6. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**
7. 発行されたURLを `config.js` の `GAS_URL` に貼り付け。

> **Code.gs を直したら、必ず「デプロイを管理 → 編集（鉛筆）→ バージョン：新バージョン → デプロイ」で更新してください。** 保存だけでは公開中のWebアプリに反映されません。この方法ならURLは変わりません。

---

## 2. スプレッドシートのテーブル定義

### Users（会員）
| 列 | 内容 |
|---|---|
| userId | `U` + ランダム12桁 |
| email | ログインID（小文字で保存） |
| nickname | 表示名 |
| salt | ユーザーごとのソルト |
| hash | SHA-256（ソルト＋ペッパー、100回ストレッチ）のBase64 |
| isFirstLogin | TRUE の間はパスワード変更以外の操作不可 |
| failCount | 連続ログイン失敗回数（5回で15分ロック） |
| lockedUntil | ロック解除日時 |
| createdAt / lastLoginAt | 登録・最終ログイン日時 |
| role | `member`（将来の管理者用） |

### Categories（百選の分類）
| 列 | 内容 |
|---|---|
| categoryId | 英字ID（例：`low_mountain`） |
| name | 表示名（例：日本100低山） |
| group | `main`＝上段のおすすめ4分野、`other`＝そのほかの百選 |
| icon | 絵文字1つ |
| sourceUrl | 出典URL |
| sort | 並び順 |

### Spots（スポット）
| 列 | 内容 |
|---|---|
| spotId | 一意なID（例：`S0001`） |
| category | Categories.categoryId |
| name / pref | 名称・都道府県（`東京都` など正式名） |
| lat / lng | 緯度・経度（Googleマップで右クリック→数値をコピー） |
| distanceKm / durationMin / difficulty | コース距離・所要時間（分）・難易度（任意） |
| description | 一覧に出す短い紹介文（1〜2文） |
| videoFileId | Google Earth Studio動画のDriveファイルID（任意） |
| sourceUrl | 出典URL |
| sample | `TRUE`＝サンプル行（画面に「サンプル」表示） |
| updatedAt | 更新日時 |

### Plans（計画）
`planId, userId, title, date, start, mode, itemsJson, memo, createdAt, updatedAt`
`itemsJson` は行程の配列（`type, spotId, name, lat, lng, stay, note`）。

### Guides（AI解説のキャッシュ）
`spotId, guideJson, model, createdAt` — 一度作った解説を保存し、API利用を節約します。作り直したい場合はその行を削除してください。

### 百選データの登録について
- `setup` が入れる10件は**動作確認用のサンプル**です。特に4分野（低山・サイクリング・散歩道・遊歩道）のサンプルは、実際の選定リストに含まれるかを公式リストで確認のうえ差し替えてください。
- 各百選の正式な一覧は [日本百選一覧](https://j100s.com/100.html) から各選定団体のページをたどって確認し、Spotsシートへ貼り付けます（CSVを作って「ファイル → インポート → 現在のシートに追加」が便利です）。
- シートを編集したら、GASで `clearMasterCache` を実行すると即反映されます（実行しなくても10分で反映）。
- 新しい百選を増やすときは Categories に1行追加するだけで、画面のボタンが増えます。

---

## 3. Gemini API キー
1. [Google AI Studio](https://aistudio.google.com/) で「Get API key」→ キーを作成。
2. スクリプトプロパティ `GEMINI_API_KEY` に設定（**config.js やGitHubには絶対に書かない**）。
3. 音声ガイドは句点ごとに約280字ずつ合成し、再生しながら次を先読みします。TTSが失敗したときはブラウザ内蔵の読み上げに自動で切り替わります。
4. モデル名が変わった場合は、スクリプトプロパティ `GEMINI_MODEL` / `GEMINI_TTS_MODEL` を書き換えるだけで切り替えられます（コード修正・再デプロイ不要）。

### 読み上げ原稿の「前置き混入」対策（二重の仕組み）
1. **システムプロンプト固定**：`GUIDE_SYSTEM` で挨拶・前置き・読み方の指示・記号を禁止し、JSONスキーマで `narration` 欄に本文だけを出させます。
2. **後処理**：`sanitizeNarration_()` が「承知しました」「以下が〜」「〜で読み上げてください」、括弧の演出指示、記号などを除去。TTSにはこの清掃済み本文**だけ**を渡し、指示文は一切付けません。

---

## 4. Google Drive の準備
1. Driveにフォルダを2つ作ります（例：`hyakusen-tabi/videos`、`hyakusen-tabi/tts-cache`）。
2. `tts-cache` のフォルダID（URLの `folders/` の後ろ）を `DRIVE_FOLDER_ID` に設定。
3. `videos` の動画ファイルは、共有 → 一般的なアクセス →「**リンクを知っている全員**（閲覧者）」にします。こうしないと他の人の画面で再生できません。

---

## 5. Google Earth Studio でルート紹介動画を作る
1. [Google Earth Studio](https://earth.google.com/studio/) にGoogleアカウントでログイン。
2. 「Blank Project」または「Quick Start → Fly To / Orbit」を選び、Spotsシートの緯度経度を入力してカメラを配置。
   - 低山：Orbit（山頂を周回）
   - サイクリング・散歩道：キーフレームをコース沿いに置き、Fly To でつなぐ
3. 長さ20〜40秒、1280×720、30fps程度がおすすめ（スマホでも軽く再生できます）。
4. Render で書き出し（連番画像で出力された場合は、手元で動画にまとめます）：
   ```
   ffmpeg -framerate 30 -i spot_%03d.jpeg -c:v libx264 -pix_fmt yuv420p -crf 23 spot.mp4
   ```
5. 動画をDriveの `videos` に上げ、「リンクを知っている全員」で共有。
6. 共有リンク `https://drive.google.com/file/d/【ここがID】/view` のIDを Spots の `videoFileId` に貼る → 案内画面に表示されます。
7. Google Earth Studio の利用規約に従い、映像内の「Google Earth」などのクレジット表記は消さずに残してください。

---

## 6. GitHub Pages へ公開
1. リポジトリ `hyakusen-tabi` を作り、`index.html` `config.js` `app.js` を置く（`Code.gs` はGAS側だけでOK。置いても動作に影響はありません）。
2. Settings → Pages → Branch: `main` / `(root)` → Save。
3. `https://kenken6291.github.io/hyakusen-tabi/` で開いて確認。
4. 更新したら `config.js` の `VERSION` を上げると、画面右上とフッターに反映されます。

---

## 7. 音声入力（途切れ防止）の調整
`config.js` の `SPEECH` で調整します。
- `silenceMs`（既定3500ms）：話し終えてから自動確定までの待ち時間。言葉の間が長い方は 5000〜6000 に。
- `firstWaitMs`（既定10000ms）：何も話さないときに待つ最長時間。
- 仕組み：`continuous=true` で聞き続け、ブラウザ側が無音で勝手に終了しても利用者が止めるまで自動で再開。確定済みの文字は再開をまたいで保持し、最後の発話から `silenceMs` 経過で確定（デバウンス）。Android版Chromeの「同じ文が二重に入る」癖も補正しています。

---

## 8. よくあるトラブル
| 症状 | 確認すること |
|---|---|
| データを読み込めない | `GAS_URL` が最新か／デプロイのアクセスが「全員」か／Code.gs修正後に新バージョンでデプロイしたか |
| 仮パスワードのメールが来ない | 迷惑メールフォルダ／GASの実行ログ／MailAppの1日の送信上限（無料アカウントは100通程度） |
| 動画が再生されない | Driveの共有が「リンクを知っている全員」か／`videoFileId` にURL全体ではなくIDだけを入れたか |
| 音声ガイドがブラウザ音声になる | `GEMINI_API_KEY`／`GEMINI_TTS_MODEL` の名前／`testTts` のログ |
| 音声入力が使えない | HTTPS（GitHub Pages）で開いているか／マイク許可／対応ブラウザ（Chrome・Edge・Safari） |

---

## 9. 百選リストの一括登録（v1.1.0〜）
1. 登録したいリストを、スプレッドシートに **シート名「import_カテゴリID」** で取り込みます（例：`import_low_mountain`、`import_cycling`）。Excelなら「ファイル → インポート → アップロード → 新しいシートを挿入」。
2. 1行目の見出しは自動で読み取ります：名称（山名／名称／コース名など）、所在地（都道府県）、エリア、標高、距離、所要時間、難易度、説明、緯度、経度、動画。
3. GASで `importAll` を実行 → Spotsに登録され、そのカテゴリのサンプル行は削除、続けて位置（緯度経度）を自動検索します。
4. Spotsの `geoStatus` 列が「要確認」の行は、Googleマップで調べて緯度・経度を手入力してください。「自動（確認推奨）」の行も、同名の別の場所に当たっていないか地図でざっと確認を。
5. 同じカテゴリ・同じ名称の行は上書きされるので、何度実行しても二重登録になりません。

### v1.2.0 の変更
- 「日本の紅葉名所100選」（koyo）を追加し、「日本100散歩道」（sanpo）を廃止。`importAll` または `setup` を実行すると、カテゴリの追加・削除とそのスポット・解説の削除が自動で行われます（何度実行しても安全）。
- 同じ名称でも都道府県が違えば別スポットとして登録（例：仙台と福岡の「西公園」）。
- 位置検索は約4分ごとに区切り、残りがあれば1分後に自動で続きを実行します。1日の検索上限に達した場合は24時間後に再開します。進み具合は Spots の `geoStatus` 列で確認できます。
- 「要確認」になった行をもう一度検索したいときは `retryGeocode` を実行します。
