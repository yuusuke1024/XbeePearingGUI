# XBee API / 透過（AT）モード切替 GUI

既存設定済みの XBee を1台選択し、静的な Web Serial アプリから API モード（`AP=1`）と透過（AT）モード（`AP=0`）を切り替えるGUIです。PAN ID、Coordinator/Router、宛先アドレス、UART ボーレートなどの既存設定は変更しません。

公開ページ: [XBee API / 透過（AT）モード切替 GUI](https://yuusuke1024.github.io/XbeePearingGUI/)

## 使い方

1. `docs/index.html` を GitHub Pages など HTTPS の静的サイト、または localhost で配信します。
2. Web Serial 対応の Chrome / Edge で開きます。
3. `XBee のポートを選択` から設定対象を1台選びます。
4. 目的の方向のボタンを押します。
   - `透過（AT）→ API（AP=1）`: `+++` でATコマンドモードへ入り、AP=1を保存します。
   - `API（AP=1）→ 透過（AT / AP=0）`: APIフレームでAP=0をキューし、WRで保存します。
5. 処理中はキャンセルできます。未選択、切断、応答タイムアウト、書き込み失敗のいずれでもセッションとWeb Serialポートを解放します。

2つのボタンは現在モードを自動判定して切り替えるものではありません。必ず接続中のXBeeの現在モードに合う方向を選んでください。透過（AP=0）のXBeeに `API（AP=1）→ 透過` を押すと、検出用APIバイナリが透過データとして扱われる可能性があります。

## 正確な送信列

### 透過（AT）→ API（AP=1）

ボーレート候補を順に試して `+++` の応答を確認し、設定時には次のASCII列だけを送信します。

```text
+++
ATAP1\r
ATWR\r
ATCN\r
```

各コマンドの `OK` を確認してから次へ進みます。

### API（AP=1）→ 透過（AT / AP=0）

APIモードのボーレートを、Queue Local AT Command（`0x09`）によるAP queryで検出します。検出用queryの後、設定フレームとして送るのは次の2フレームだけです。これはASCIIの `ATAP0` を送る処理ではありません。

```text
7E 00 04 09 01 41 50 64       # 0x09 AP query
7E 00 05 09 02 41 50 00 63    # 0x09 AP=0 queued
7E 00 04 08 03 57 52 4B       # 0x08 WR
```

各フレームに対応する `0x88` Local AT Command Response のframe ID、AT command、status（`0x00`=成功）を照合します。AP=0の適用後はUARTが透過形式になるため、追加のAPIフレームやATコマンドを送らずに終了します。

※上記のAP=0フレーム例のchecksumは実装上のframe IDに合わせて生成されます。frame IDは応答照合のため0以外を使います。

このツールが変更する設定はAPだけです。`ATID`、`ATCE`、`ATDH`、`ATDL`、`ATBD`、`ATRE`、`ATFR`、`ATSM`、`ATAO`などは送信しません。AP=2（エスケープAPI）は対象外です。このツールで作成したAP=1のXBeeをAP=0へ戻す用途を想定しています。

## ローカルテスト

依存パッケージはありません。

```bash
npm test
node --check docs/xbee.js
node --check docs/app.js
```

テストでは、ASCII/API双方のframe列、checksum、fragmented受信、複数frame、noise、不正checksum、無関係frameを後続の正しい応答前に受信するケース、ボーレートfallback、AP/WR失敗、AP2非対応、切断、キャンセル、ポートcleanupを検証します。実機とのUSB接続と各XBeeのモード切替結果は別途確認が必要です。

## 実機に関する注意

- Web Serialは安全なコンテキスト（HTTPSまたはlocalhost）でのみ利用できます。
- API側はAP=1の非エスケープAPIフレームのみ対応します。AP=2は明示的に拒否します。
- AP=0保存後はUARTが透過（AT）形式になります。必要に応じてXBeeを電源再投入してください。
- XBeeの現在のUARTボーレートは変更しません。候補は1200〜115200 bpsの標準値です。
- `0x09 AP=0`をキューしてから`0x08 WR`を送るため、AP=0適用後にWR応答がAPI形式で返らない機種差がないか、実機で確認してください。
