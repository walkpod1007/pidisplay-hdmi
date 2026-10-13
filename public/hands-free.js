'use strict';
// The HDMI display has no interactive controls. Setup lives on the phone.
(async function updateHandsFree() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('status unavailable');
    const status = await response.json();
    const phase = status.phase || 'source';
    document.body.dataset.onboarding = String(phase !== 'ready');
    document.body.dataset.setupPhase = phase;
    document.getElementById('setup-title').textContent = phase === 'wifi' ? '1 / 連上 Wi-Fi' : '2 / 連結 Sonos 或 Roon';
    document.getElementById('setup-description').textContent = phase === 'wifi' ? '手機加入設定熱點，再掃 QR code 選擇室內 Wi-Fi。' : '掃碼選擇 Sonos 房間或 Roon 區域。';
    const local = await fetch('/api/local-setup');
    if (local.ok) {
      const setup = await local.json();
      document.getElementById('remote-pin').textContent = `配對碼 ${setup.pin}`;
    }
  } catch {
    document.body.dataset.onboarding = 'true';
  }
  setTimeout(updateHandsFree, 5000);
})();
