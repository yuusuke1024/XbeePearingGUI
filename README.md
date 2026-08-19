# XBee API モード設定 GUI

既存設定済みの XBee を1台ずつ選択し、静的な Web Serial アプリから API モード (`AP=1`) へ切り替える最小構成のGUIです。PAN ID、役割、宛先アドレス、UART ボーレートなどのネットワーク設定は変更しません。

公開ページ: [XBee API モード設定 GUI](https://yuusuke1024.github.io/XbeePearingGUI/)

## 使い方

1. `docs/index.html` を GitHub Pages など HTTPS の静的サイト、または localhost で配信します。
2. Web Serial 対応の Chrome / Edge で開きます。
3. `XBee のポートを選択` から設定対象を1台選びます。
4. `API モード (AP=1) を書き込む` を押します。
5. 複数台を設定する場合は、1台ごとにポートを選び直して同じ操作を行います。

処理中はキャンセルできます。未選択、キャンセル、切断、応答タイムアウト、書き込み失敗のいずれでもセッションを閉じ、Web Serial ポートを解放します。

## 厳密な送信列

各 XBee の現在の UART ボーレートを候補から自動検出します。検出のために必要なコマンドモード移行の `+++` を除き、設定時に送る AT コマンドは次の3つだけです。

```text
+++
ATAP1\r
ATWR\r
ATCN\r
```

`ATID`、`ATCE`、`ATDH`、`ATDL`、`ATBD`、`ATRE`、`ATFR`、`ATSM`、`ATAO` などは送信しません。`ATAP1` または `ATWR` が `OK` 以外の場合、後続コマンドを送らず失敗として扱います。

## ローカルテスト

依存パッケージはありません。

```bash
npm test
node --check docs/xbee.js
node --check docs/app.js
```

テストでは、正確な送信列、禁止コマンドがないこと、`enableApiMode` 自体のボーレート自動検出、AP/WR 失敗・切断・ポートオープン失敗時の cleanup、未選択エラーを検証します。実機との USB 接続や XBee の電源再投入は別途必要です。

## 実機に関する注意

- Web Serial は安全なコンテキスト（HTTPS または localhost）でのみ利用できます。
- XBee がすでに API モードの場合、AT コマンドモードへ入れないためボーレート検出に失敗します。
- `AP=1` の保存後は UART が API フレーム形式になります。必要に応じて XBee を電源再投入してください。
- XBee の現在の UART ボーレートは変更しません。自動検出候補は 1200〜115200 bps の標準値です。
