# NotiSpam Cleaner — 通知スパムクリーナー

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v1.0.1-blue.svg)](https://chromewebstore.google.com/detail/notispam-cleaner-notifica/dahnhdiabhegihofjijbchegffnkiaap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**NotiSpam Cleaner** は、Google Chrome の「通知許可」設定をスキャン・一括ブロックして整理し、通知スパムからブラウザを保護するためのプライバシー優先のオープンソースな Chrome 拡張機能です。不審なウェブサイトに与えられた通知許可設定を解除・ブロックすることで、偽のウイルス警告や不要な広告通知が画面に届くのを防ぎます。

> [!NOTE]
> **互換性:** この拡張機能は `chrome.contentSettings` API を使用しているため、Chromium系ブラウザ (Google Chrome、Microsoft Edge、Brave、Vivaldi、Opera など) でのみ動作します。Firefox や Safari には対応していません。

*他の言語で読む:*
* 🇺🇸 [English (README.md)](README.md)

## 開発の背景：通知スパム問題とは？
多くの詐欺サイトや悪質なウェブサイトは、偽のロボット認証 (「ロボットではないことを証明するために『許可』を押してください」) や、偽のセキュリティ警告 (「システムが感染しています！」) などを使って、ユーザーに通知許可ボタンをクリックさせようとします。
一度許可してしまうと、ブラウザを閉じていても、PCやスマートフォンの画面上に大量の不適切な広告やウイルス感染警告が通知ポップアップとして届くようになります。

Chrome の仕様上、現在許可されているすべてのサイト一覧を一括で取得する API が提供されていないため、不要な許可ルールを検出することは困難です。**NotiSpam Cleaner** は、ローカルの閲覧履歴、ブックマーク、現在開いているタブからドメイン名を抽出し、それらの通知設定の状態を効率的に監査・スキャンすることでこの問題を解決します。

## 主な機能と特徴

*   **🔒 100% プライバシー優先 (完全ローカル＆オープンソース):** すべてのスキャンおよびブロック処理は、ユーザーのデバイス上 (ローカル) で完結します。閲覧履歴などの個人データが外部サーバーに送信または収集されることは一切ありません。
*   **🔍 簡単スキャン＆ワンクリック一括ブロック:** 閲覧履歴、ブックマーク、開いているタブをローカルでスキャンし、現在通知を許可しているサイトを「信頼できるサイト」と「疑わしいスパムサイト」に自動分類。ワンクリックで一括ブロックできます。
*   **🛡️ リアルタイム監視＆サイレント保護:** 許可設定を常時監視し、不審なサイトが通知許可を取得した瞬間に自動検知してブロック。警告ポップアップを表示するモードに加え、バックグラウンドで静かにブロックする「サイレント保護 (ファミリーモード)」も搭載しています。

## インストール方法

### 方法 A: Chrome Web Store からインストール (推奨)
[Chrome ウェブストア](https://chromewebstore.google.com/detail/notispam-cleaner-notifica/dahnhdiabhegihofjijbchegffnkiaap) から直接インストールできます。

### 方法 B: 開発者モードによる手動インストール
1.  本リポジトリをクローンまたはダウンロードします。
    ```bash
    git clone https://github.com/mah-jp/notispam-cleaner.git
    ```
2.  Google Chrome を開き、アドレスバーに `chrome://extensions/` と入力して拡張機能ページを開きます。
3.  右上の「**デベロッパー モード**」のトグルをオンにします。
4.  左上の「**パッケージ化されていない拡張機能を読み込む**」をクリックし、クローンしたディレクトリ内の `chrome_extension` フォルダを選択します。

## 技術的な特徴

*   **Manifest V3 完全対応:** セキュリティに優れた最新の Chrome 拡張機能の仕様に準拠しています。
*   **ローカル連携:** ブラウザの `chrome.contentSettings` API と直接同期して、各ドメインの通知設定を安全に変更します。
*   **状態管理:** 設定情報やホワイトリスト (信頼リスト) の管理には `chrome.storage.local` を使用し、サービスワーカーのライフサイクルに対応。メモリリークやステート消失を防ぎます。

## リアルタイム保護の動作フロー

拡張機能の「リアルタイム監視（Guard）」および「サイレント保護（Silent Guardian）」における通知ブロックと許可の処理フローは以下の通りです。

```mermaid
graph TD
    %% スタイルの定義
    classDef page fill:#f5f5f5,stroke:#333,stroke-width:2px;
    classDef bg fill:#e1f5fe,stroke:#0288d1,stroke-width:2px;
    classDef storage fill:#efebe9,stroke:#5d4037,stroke-width:2px;
    classDef api fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef user fill:#fff3e0,stroke:#ef6c00,stroke-width:2px;

    subgraph web_page ["Web Page / Content Script"]
        A[ページロード / 許可変更の検知] --> B{通知許可が granted か?}
        B -- Yes --> C[メッセージ送信:<br/>notification_granted]
    end

    subgraph background_service_worker ["Background Service Worker"]
        C --> D{Guard機能が有効か?}
        D -- No --> E[処理終了]
        D -- Yes --> F{ドメインがホワイトリストに登録済か?}
        F -- Yes --> G["処理終了 (許可状態を維持)"]
        F -- No --> H[直ちに通知許可を block に設定]

        H --> I{サイレント保護モードか?}
        
        %% サイレントモードの流れ
        I -- Yes --> J[ブロック数をカウントアップ]
        J --> K[バッジ数更新 & 赤色表示]
        K --> L[サイレントブロック完了]
        
        %% 通常モードの流れ
        I -- No --> M[デスクトップ警告通知を表示]
    end

    subgraph chrome_storage_api ["Chrome Storage & API"]
        H -.-> |設定変更| API_Block[chrome.contentSettings]
        F -.-> |データ参照| Store_WL[chrome.storage.local]
        J -.-> |件数更新| Store_Count[chrome.storage.local]
    end

    subgraph user_action_sub ["User Action (デスクトップ警告通知)"]
        M --> N{ユーザーのアクション}
        N -- "閉じる (Dismiss)" --> O["通知を消去 (ブロック維持)"]
        N -- "信頼して許可 (Trust & Allow)" --> P[ホワイトリストにドメインを追加]
        P --> Q[通知許可を allow に再設定]
        Q --> R[通知を消去 & アイコン状態更新]
    end

    P -.-> |ホワイトリスト保存| Store_WL
    Q -.-> |設定変更| API_Allow[chrome.contentSettings]

    %% クラスの適用
    class A,B,C page;
    class D,E,F,H,I,J,K,L,M bg;
    class Store_WL,Store_Count storage;
    class API_Block,API_Allow api;
    class N,O,P,Q,R user;
```


## サポート言語 (ロケール)

世界中のあらゆる地域で利用できるよう、以下の言語に完全対応 (ローカライズ) しています。
*   英語 (`en`) - デフォルト
*   日本語 (`ja`)
*   スペイン語 (`es`)
*   ロシア語 (`ru`)
*   中国語 (簡体字: `zh_CN` / 繁体字: `zh_TW`)
*   ウクライナ語 (`uk`)
*   韓国語 (`ko`)
*   フランス語 (`fr`)
*   ドイツ語 (`de`)
*   ポルトガル語 (`pt`)
*   アラビア語 (`ar`)
*   Hebrew (ヘブライ語: `he`)

## 作者
*   **Masahiko OHKUBO** (GitHub: [@mah-jp](https://github.com/mah-jp))

## ライセンス
このプロジェクトはオープンソースであり、[MIT ライセンス](LICENSE)の下で提供されています。
