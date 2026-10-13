# PiDisplay HDMI：Sonos／Roon 正在播放螢幕

把一台 Raspberry Pi Zero 2 W 接上 HDMI 面板，開機就顯示 Sonos 或 Roon 正在播的歌：完整封面、歌名、專輯、歌手，右下角一行設定網址與配對碼。不用滑鼠鍵盤，不用登入任何音樂服務（讀的是喇叭自己回報的播放資訊）。

- 第一次開機沒網路時自己開熱點，手機掃螢幕 QR 設 Wi-Fi
- 手機開設定頁選要跟哪一台 Sonos 房間或 Roon 區域
- 封面會去 Apple 公開目錄找高解析度版本，找不到就用喇叭給的原圖
- 支援橫放與直放，解析度照面板原生（實機 2048×1536 的 9.7 吋 iPad 面板跑得動）

## 硬體

| 項目 | 說明 |
|---|---|
| Raspberry Pi Zero 2 W | 其他 64 位元機種（3B+／4／5）也可以；原始 Zero W／WH 不行（32 位元） |
| HDMI 面板＋驅動板 | 任何 HDMI 螢幕都行；高解析度面板要看驅動板時序（見下面「畫面糊」） |
| microSD 8 GB 以上 | |
| 電源 | Zero 2 W 用 5V 2.5A；mini HDMI 轉接線 |
| 音源 | 區網內的 Sonos 喇叭（S2），或 Roon Core |

## 燒卡與安裝

1. 用 [Raspberry Pi Imager](https://www.raspberrypi.com/software/) 燒 **Raspberry Pi OS Lite (64-bit)**（Bookworm 或更新）。
   燒之前按「編輯設定」：主機名稱填 `pidisplay`、設使用者與密碼、填家裡 Wi-Fi、開啟 SSH。
2. 插卡開機，從電腦 SSH 進去：
   ```sh
   ssh 你的使用者@pidisplay.local
   ```
3. 抓程式、安裝（會裝 Node.js、Python/Pygame、X11、字型，約 10 分鐘）：
   ```sh
   sudo apt-get install -y git
   git clone https://github.com/walkpod1007/pidisplay-hdmi.git
   cd pidisplay-hdmi
   sudo bash install.sh
   ```
   安裝器會先把既有設定備份到 `/var/backups/pidisplay/`，裝完自動啟動兩個服務：`pidisplay`（網頁與音樂服務，8787 埠）與 `pidisplay-kiosk`（全螢幕畫面）。
4. **Zero 2 W 一定要做這步**（其他機種也建議）：
   ```sh
   sudo mkdir -p /etc/systemd/system/pidisplay-kiosk.service.d
   sudo cp config/pidisplay-kiosk.override.conf /etc/systemd/system/pidisplay-kiosk.service.d/override.conf
   sudo systemctl daemon-reload && sudo systemctl restart pidisplay-kiosk
   ```
   這份設定做兩件事：把畫面輸出改成純軟體（512 MB 記憶體跑高解析度不然會一直換頁，CPU 25% → 1%），以及把螢幕轉成直式。橫放的把裡面 `PIDISPLAY_ROTATION` 改成 `normal`。
5. 重開機一次：`sudo reboot`。

## 第一次使用

1. 螢幕出現 QR 與設定網址。手機瀏覽器開 `http://pidisplay.local:8787/setup`（解析不到就打螢幕上顯示的 IP）。
2. 輸入螢幕上的六位配對碼。
3. 選 Sonos 房間或 Roon 區域。「自動」模式優先顯示正在播的 Sonos，其次 Roon。
4. Roon 使用者要到 Roon「設定 → 擴充功能」啟用 PiDisplay HDMI，再回設定頁選區域。

沒有網路時（例如搬去別的地方）它會自己開 `PiDisplay-Setup` 熱點，手機掃螢幕 QR 連上、在設定頁選新 Wi-Fi。

## 畫面糊、解析度不對

高解析度面板的驅動板常把 60 Hz 設成首選，像素時脈超過 Zero 2 W 的 HDMI 上限，X 會退到 720×576。解法是同解析度降到 30〜40 Hz：照 `config/10-pidisplay-monitor.conf.example` 裡的說明算一組 modeline，放到 `/etc/X11/xorg.conf.d/10-pidisplay-monitor.conf`，重啟 kiosk。

畫面出現紫色色塊、綠色亮點、抖動＝時脈還是太貼近上限，再往下降幾 Hz。這是訊號問題不是程式問題。

## 驗證與除錯

```sh
systemctl status pidisplay pidisplay-kiosk
curl http://127.0.0.1:8787/api/status
journalctl -u pidisplay-kiosk -n 50
```

跑測試（開發機或 Pi 上都可以）：

```sh
npm ci && npm test
python3 network_test.py
python3 native_display_test.py
```

## 還原

停掉兩個服務就回到原本的系統；安裝前的檔案都在 `/var/backups/pidisplay/<時間戳>/`。

```sh
sudo systemctl disable --now pidisplay pidisplay-kiosk
```

## 隱私

配對碼、Wi-Fi 設定與熱點密碼只存在 Pi 的 `/var/lib/pidisplay/state`，只有區網能連設定頁，沒有任何對外網路入口，也不需要任何帳號登入。分享這個 repo 不會帶出你的設定。

## 其他

- 技術細節與沿革：`docs/technical-notes.md`
- 授權：MIT
