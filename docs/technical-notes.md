# PiDisplay：Sonos／Roon HDMI 歌曲螢幕

本版僅提供 Sonos 與 Roon。已移除 Spotify 直接登入、開發者 App、Client ID、OAuth 與輪詢；Sonos 喇叭原本使用的音樂服務不受影響。

## 使用流程

1. 插電後自動顯示，不需要滑鼠鍵盤。
2. 尚未連網：手機掃螢幕 QR 加入 PiDisplay-Setup，再開設定頁選室內 Wi-Fi。切換後手機連回室內 Wi-Fi，掃螢幕的新 QR。
3. 輸入螢幕六位配對碼，選 Sonos 房間或 Roon 區域。自動模式優先正在播放的 Sonos，其次 Roon。
4. Roon 使用者在 Roon「設定 → 擴充功能」啟用 PiDisplay HDMI，再回設定頁選區域。

設定頁：http://pidisplay.local:8787/setup。名稱無法解析時使用螢幕 QR 的當前 IP；測試機曾用192.168.4.63，DHCP可能改變。

## 原生高解析度

HDMI 前端為 Python/Pygame，手機設定仍用網頁。Chromium 已不再啟動。使用 HDMI 驅動板 EDID 原生模式，不再限制720p。完整封面下方依序歌名、專輯、歌手；字型與 QR 隨畫素尺寸放大。

已加入2048×1536橫式、1536×2048直式繪圖測試。預定iPad IPS面板及HDMI驅動板仍需實接核實；目前測試螢幕回報最高1920×1080。來源封面不一定具有面板同等畫素；Sonos依音樂服務提供，Roon請求最大1536×1536。

封面大圖來源：Apple Music 用曲目 id 查 Apple 公開目錄；其他服務（Amazon、Spotify、Tidal 等）用歌名＋歌手搜尋同一目錄，歌手與歌名正規化後都相等才採用（寧可沒大圖也不顯示錯專輯）；電台不查。皆在背景抓取，失敗維持 Sonos 原圖。

資訊列背景預設為平色深綠 (16,24,20)（各分量為 4 的倍數，6-bit 面板不抖色，也不持有背景圖）；要朦朧模糊封面背景請設環境變數 `PIDISPLAY_BG=blur`。

播放畫面不再顯示 QR Code，右下角以一行小字列出設定頁網址（去掉 http://）與配對碼；只有最初設定 Wi-Fi 的階段才顯示 QR，選擇播放來源階段改列網址文字。

豎放以 sudo systemctl edit pidisplay-kiosk 設定：

```ini
[Service]
Environment=PIDISPLAY_ROTATION=left
```

可選normal、left、right、inverted；儲存後執行 sudo systemctl restart pidisplay-kiosk。方向依實際安裝確認。

記憶體小的機種（Zero 2 W，512 MB）跑高解析度時，同一處再加兩行，讓畫面程式走純軟體輸出：

```ini
[Service]
Environment=SDL_FRAMEBUFFER_ACCELERATION=0
Environment=SDL_RENDER_DRIVER=software
```

不設時 SDL 會自動用 OpenGL 當視窗底圖：2048×1536 下多佔約 100 MB 圖形記憶體，而且每次更新整張重送，機器會一直換頁。2026-10-03 實機量測（播放中）：設定前負載 4 以上、畫面程式佔 25% CPU、每秒約 1500 次換頁；設定後負載 0.3、畫面程式不到 1%、換頁歸零。install.sh 目前不會自動寫這兩行（旋轉與面板時序也是機上設定），重灌後要手動補。

## 新卡部署

需要 Raspberry Pi OS 64-bit（aarch64）與NetworkManager，建議Lite。先用Imager設定Wi-Fi、帳號及SSH，再把程式包傳進Pi。

```sh
tar -xzf pidisplay-hdmi.tar.gz
cd hdmi
sudo bash install.sh
```

程式包不是可燒錄OS映像，不能只複製進bootfs。安裝器先備份至/var/backups/pidisplay，再安裝Node.js、Python/Pygame、X11與字型。若有既有桌面執行，會保留桌面並提示處理。現測試機已備份並停用lightdm。

## 驗證

```sh
npm test
python3 network_test.py
python3 native_display_test.py
sh -n kiosk.sh
bash -n install.sh
systemctl status pidisplay pidisplay-kiosk
```

已驗：Sonos實際metadata/封面、Wi-Fi失敗恢復熱點及成功連線、先前版本系統重開機自啟、輕量HDMI實際截圖。最新原生解析度版另記錄部署驗證。未驗：預定iPad面板實接、手機實際掃碼、斷電冷開機、Roon真實配對。Spotify已取消，不屬於待驗收。

設定與配對資料在/var/lib/pidisplay/state，勿打包分享。管理API需PIN session，PIN與Wi-Fi QR只供本機讀取。使用區網HTTP，不需要公開網際網路入口。

原電子紙程式與原卡備份保持不變。恢復舊桌面可停用pidisplay-kiosk再啟用lightdm，原始設定位於/var/backups/pidisplay/pre-deploy-20260917。
