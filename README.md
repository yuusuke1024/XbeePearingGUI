# XbeePearingGUI

XCTU の代替として、XBee の最低限の通信設定を行う静的 Web アプリです。Chrome / Edge の Web Serial API を使い、通常の1対1ペアリングと、3 台以上を対象にした API モード設定に対応します。

## Quick start

```
https://yuusuke1024.github.io/XbeePearingGUI/
```

Chrome または Edge で GitHub Pages URL を開く

1. XBee を 2 台 USB シリアルとして接続する
3. `XBee A のポートを選択` と `XBee B のポートを選択` を押して各ポートを選ぶ
4. 必要に応じてボーレートを選ぶ（初期値は `9600`）
5. PAN ID を入力する
6. Coordinator の組み合わせを選ぶ
7. `ペアリング設定を書き込む` を実行する
8. 右側のログで `SL` 読み取り結果と各 AT コマンドの成否を確認する

API モードを使う場合は、`API モードを ON にする (ATAP=1)` にチェックを入れ、`XBee を追加` から 3 台以上のポートを選択して実行する。

## このツールが行うこと

- 通常の1対1ペアリングで変更する設定: `ID`, `CE`, `DL`, `BD`
- API モードで変更する設定: `ID`, `CE`, `BD`, `AP=1`
- 読み取る設定: `SL`
- 保存 / 終了: `WR`, `CN`

Function Set / Firmware は変更しません。`ZIGBEETHReg` のまま使う前提です。`DH`、`SM`、`NI`、`EE`、`KY`、`RE`、`FR` など、上記以外の設定は変更しません。

## 制約と注意

- Web Serial API 対応ブラウザが必要です。Chrome / Edge かつ HTTPS または `localhost` で開いてください。
- XBee の現在の UART ボーレートは、対応候補から自動検出します。
- 実機が必要です。`npm test` では純粋関数のみを確認し、シリアル通信の実機検証は行いません。
- 各 XBee の `SL` は読み取り専用です。このツールは各 `SL` を読み、相手側の `DL` にだけ書き込みます。
- Digi の 64bit 宛先は本来 `DH + DL` です。このツールはユーザー指定により `DH` を書き換えません。そのため、既存の `DH` が 0 以外だと通信できない可能性があります。
- API モードでは宛先を API フレームで指定するため、このツールは `DL` を変更しません。
- `AP=1` に設定した後は XBee の UART 通信が API フレーム形式になります。以後 AT コマンドモード用の接続テストには応答しない場合があります。

## ローカル確認

依存パッケージはありません。テストだけ実行できます。

```bash
npm test
```

`docs/index.html` を GitHub Pages などの HTTPS 環境で配信し、Chrome / Edge から利用してください。
