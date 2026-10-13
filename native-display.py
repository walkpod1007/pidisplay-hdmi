#!/usr/bin/env python3
"""Low-memory HDMI frontend; all setup remains in the phone web application."""
import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')
import pygame

BASE = os.environ.get('PIDISPLAY_BASE') or 'http://127.0.0.1:8787'  # override only for off-Pi test runs
FONT = os.environ.get('PIDISPLAY_FONT') or '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'  # override only for off-Pi test renders
TEXT = (211, 220, 208)
TEXT_DIM = (190, 204, 188)  # artist / status line; the dimmest text that must stay readable
MIN_CONTRAST = 4.5
# Flat info-bar colour. Every channel is a multiple of 4 so a 6-bit panel shows it exactly (no dithering bands).
BAR_BG = (16, 24, 20)
BASE_DIM = 0.5  # always darken the blurred cover at least this much


def _lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    return 0.2126 * _lin(rgb[0]) + 0.7152 * _lin(rgb[1]) + 0.0722 * _lin(rgb[2])


def contrast(fg, bg):
    a, b = luminance(fg), luminance(bg)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def max_background_luminance(text=TEXT_DIM, ratio=MIN_CONTRAST):
    return (luminance(text) + 0.05) / ratio - 0.05


def region_max_luminance(surface, rect, step=3):
    best = 0.0
    for y in range(rect.top, rect.bottom, step):
        for x in range(rect.left, rect.right, step):
            best = max(best, luminance(surface.get_at((x, y))[:3]))
    return best


def meta_parts(track, fallback='NOW PLAYING'):
    parts = [track.get('service') or track.get('source') or fallback, track.get('quality'), track.get('zone')]
    return [str(p).strip() for p in parts if p and str(p).strip()]


def meta_label(track, error=False, fallback='NOW PLAYING'):
    """platform · quality · room, then the time; missing parts are skipped."""
    return ' · '.join(meta_parts(track, fallback))


def blurred_background(data, size, bar_rect):
    """Cover enlarged to fill the screen, heavily blurred and darkened so light text keeps >=4.5:1."""
    w, h = size
    source = pygame.image.load(io.BytesIO(data)).convert()
    sw, sh = source.get_size()
    scale = max(w / sw, h / sh)
    cw, ch = min(sw, max(1, round(w / scale))), min(sh, max(1, round(h / scale)))
    crop = source.subsurface(((sw - cw) // 2, (sh - ch) // 2, cw, ch))
    # Halve step by step (a single big smoothscale aliases fine strokes), then grow back in 2x steps.
    cur = crop
    tw, th = max(4, w // 48), max(4, h // 48)
    while cur.get_width() > tw or cur.get_height() > th:
        cur = pygame.transform.smoothscale(cur, (max(tw, cur.get_width() // 2), max(th, cur.get_height() // 2)))
    while cur.get_width() < w or cur.get_height() < h:
        cur = pygame.transform.smoothscale(cur, (min(w, cur.get_width() * 2), min(h, cur.get_height() * 2)))
    bg = cur
    del source, crop
    # Darken once, measured on the real blurred pixels under the text (the brightest ones decide).
    samples = {tuple(bg.get_at((x, y))[:3]) for y in range(bar_rect.top, bar_rect.bottom, 6) for x in range(bar_rect.left, bar_rect.right, 6)}
    limit = max_background_luminance() * 0.95
    factor = BASE_DIM
    for _ in range(40):
        level = int(factor * 255)
        if max(luminance((c[0] * level // 255, c[1] * level // 255, c[2] * level // 255)) for c in samples) <= limit:
            break
        factor *= 0.93
    level = max(0, min(255, int(factor * 255)))
    bg.fill((level, level, level), special_flags=pygame.BLEND_RGB_MULT)
    return bg


def fetch(url, limit=12 * 1024 * 1024):
    timeout = 10 if '-art/' in url else 5  # cover from a slow speaker or CDN may need longer than status
    with urllib.request.urlopen(url, timeout=timeout) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Display asset too large')
    return data


class Feed:
    def __init__(self):
        self.lock = threading.Lock()
        self.status = {}
        self.setup = {}
        self.assets = {}
        self.error = False
        self.updated = time.monotonic()

    def update(self):
        try:
            status = json.loads(fetch(BASE + '/api/status'))
            setup = json.loads(fetch(BASE + '/api/local-setup'))
            # QR codes only while the Wi-Fi setup step is showing; later phases print the URL as text.
            sources = {key: setup.get(key) for key in ('qr', 'wifiQR')} if status.get('phase') == 'wifi' else {}
            sources['art'] = (status.get('track') or {}).get('art')
            assets = {}
            for key, url in sources.items():
                if not url:
                    continue
                if key in self.assets and self.assets[key][0] == url:
                    assets[key] = self.assets[key]
                    continue
                try:
                    if url.startswith('data:image/png;base64,'):
                        data = base64.b64decode(url.split(',', 1)[1], validate=True)
                    else:
                        data = fetch(BASE + url if url.startswith('/') else url)
                    assets[key] = (url, data)
                except (OSError, ValueError):
                    pass  # Retry failed cover/QR downloads on the next poll.
            with self.lock:
                self.status, self.setup, self.assets = status, setup, assets
                self.error, self.updated = False, time.monotonic()
        except (OSError, ValueError):
            with self.lock:
                self.error = True

    def run(self, stop):
        while not stop.is_set():
            self.update()
            stop.wait(3)

    def snapshot(self):
        with self.lock:
            return self.status, self.setup, self.assets, self.error, self.updated


class Display:
    def __init__(self, surface):
        self.surface = surface
        self.fonts = {}
        self.images = {}
        self.bg = None
        self.bg_key = None
        self.sig = None
        self.progress_key = None

    def font(self, size):
        size = max(10, int(size))
        if size not in self.fonts:
            self.fonts[size] = pygame.font.Font(FONT, size)
        return self.fonts[size]

    def setup_line(self, setup, size, max_width):
        """'192.168.4.63:8787/setup · 配對碼 123456' without http://; the URL is cut first so the pairing code stays."""
        url = re.sub(r'^https?://', '', str(setup.get('url') or '')).replace('\n', ' ')[:200]
        pin = str(setup.get('pin') or '')
        font = self.font(size)
        tail = ('配對碼 ' + pin) if pin else ''
        sep = ' · ' if url and tail else ''
        def build(u):
            return u + sep + tail
        if font.size(build(url))[0] > max_width:
            while url and font.size(build(url + '…'))[0] > max_width:
                url = url[:-1]
            url = url + '…' if url else ''
            sep = ' · ' if url and tail else ''
        return build(url)

    def text(self, value, xy, size, color=(211, 220, 208), width=None):
        size = max(10, int(size))
        font = self.fonts.setdefault(size, pygame.font.Font(FONT, size)) if size not in self.fonts else self.fonts[size]
        value = str(value or '').replace('\n', ' ')[:200]
        if width and font.size(value)[0] > width:
            while value and font.size(value + '…')[0] > width:
                value = value[:-1]
            value += '…'
        self.surface.blit(font.render(value, True, color), xy)

    def image(self, key, asset, rect, qr=False):
        if not asset:
            self.images.pop(key, None)
            return False
        url, data = asset
        cache_key = (url, rect.width, rect.height, qr)
        try:
            if key not in self.images or self.images[key][0] != cache_key:
                source = pygame.image.load(io.BytesIO(data))
                if not qr:
                    source = source.convert()
                scale = min(rect.width / source.get_width(), rect.height / source.get_height())
                size = (max(1, int(source.get_width() * scale)), max(1, int(source.get_height() * scale)))
                scaled = (pygame.transform.scale if qr else pygame.transform.smoothscale)(source, size).convert()
                self.images[key] = (cache_key, scaled)
            bitmap = self.images[key][1]
            self.surface.blit(bitmap, bitmap.get_rect(center=rect.center))
            return True
        except (pygame.error, ValueError):
            return False

    def background(self, asset, size, bar_rect):
        """Flat BAR_BG by default (no surface held). PIDISPLAY_BG=blur: blit the cached blurred cover, computed once per cover."""
        if os.environ.get('PIDISPLAY_BG') != 'blur' or not asset:
            self.bg_key = self.bg = None
            return
        key = (asset[0], size, bar_rect.top)
        if self.bg_key != key:
            self.bg_key = key
            try:
                self.bg = blurred_background(asset[1], size, bar_rect).convert()
            except (pygame.error, ValueError):
                self.bg = None  # remembered by bg_key, so a bad cover is not retried every frame
        if self.bg is not None:
            self.surface.blit(self.bg, (0, 0))

    def meta_line(self, parts, suffix, xy, size, width):
        """Parts joined by a drawn dot with equal space on both sides (font dot glyphs sit off-centre)."""
        size = max(10, int(size))
        if size not in self.fonts:
            self.fonts[size] = pygame.font.Font(FONT, size)
        font = self.fonts[size]
        gap = max(6, int(size * .5))
        total = sum(font.size(p)[0] for p in parts) + gap * 2 * max(0, len(parts) - 1)
        if suffix:
            total += (gap * 3 if parts else 0) + font.size(suffix)[0]
        if total > width:
            self.text(' · '.join(parts) + ('\u3000' + suffix if suffix else ''), xy, size, TEXT_DIM, width)
            return
        x, y = xy
        for i, part in enumerate(parts):
            if i:
                pygame.draw.circle(self.surface, TEXT_DIM, (x + gap, y + int(size * .62)), max(2, size // 10))
                x += gap * 2
            self.surface.blit(font.render(part, True, TEXT_DIM), (x, y))
            x += font.size(part)[0]
        if suffix:
            self.surface.blit(font.render(suffix, True, TEXT_DIM), (x + (gap * 3 if parts else 0), y))

    def _geometry(self, state=None):
        """text_width is the room for the bottom-left meta line; in the ready phase the bottom-right URL line takes its share."""
        w, h = self.surface.get_size()
        unit = min(w, h) / 768
        pad = int(w * .04)
        size = max(11, min(w, h) * .016)
        base = (pad, h - int(28 * unit))
        right = ''
        text_width = w - pad * 2
        if state is not None and (state[0] or {}).get('phase') == 'ready':
            right = self.setup_line(state[1] or {}, size, int((w - pad * 2) * .45))
            if right:
                text_width = w - pad * 2 - self.font(size).size(right)[0] - pad // 2
        label_rect = pygame.Rect(0, max(0, base[1] - 6), pad + text_width + pad // 2, int(size * 1.7) + 12).clip(pygame.Rect(0, 0, w, h))
        return w, h, unit, pad, text_width, size, base, label_rect, right

    def paint_progress(self, state, clear=True):
        """Time label and progress bar only; returns the logical rects touched ([] when nothing changed)."""
        status, setup, assets, error, updated = state
        track = status.get('track') or {}
        w, h, unit, pad, text_width, size, base, label_rect, right = self._geometry(state)
        progress = track.get('progress', 0) or 0
        duration = track.get('duration', 0) or 0
        if track.get('playing') and not error:
            progress += (time.monotonic() - updated) * 1000
        progress = min(progress, duration) if duration else 0
        def fmt(ms):
            seconds = int(ms // 1000)
            return f'{seconds // 60}:{seconds % 60:02d}'
        suffix = f'{fmt(progress)} / {fmt(duration)}' if duration else ''
        parts = meta_parts(track)
        fill = int(w * progress / duration) if duration else 0
        label_key = (error, tuple(parts), suffix, (w, h), text_width)
        old = self.progress_key
        label_changed = not clear or old is None or old[0] != label_key
        old_fill = old[1] if old else None
        fill_changed = not clear or old_fill != fill
        if not (label_changed or fill_changed):
            return []
        self.progress_key = (label_key, fill)
        bar_rect = pygame.Rect(0, h - 3, w, 3)
        dirty = []
        if label_changed:
            if clear:
                if self.bg is not None:
                    self.surface.blit(self.bg, label_rect.topleft, label_rect)
                else:
                    self.surface.fill(BAR_BG, label_rect)
            if error:
                self.text('服務重新連線中…' + (f'\u3000{suffix}' if suffix else ''), base, size, TEXT_DIM, text_width)
            else:
                self.meta_line(parts, suffix, base, size, text_width)
            dirty.append(label_rect)
        pygame.draw.rect(self.surface, (38, 50, 41), bar_rect)
        if duration:
            pygame.draw.rect(self.surface, (187, 220, 167), (0, h - 3, fill, 3))
        if fill_changed:
            lo, hi = (0, w) if old_fill is None else (min(old_fill, fill), max(old_fill, fill) + 1)
            dirty.append(pygame.Rect(lo, h - 3, max(1, min(w, hi) - lo), 3))
        return dirty

    def signature(self, state):
        """Everything that needs a full repaint; progress and clock are deliberately left out."""
        status, setup, assets, error, updated = state
        track = status.get('track') or {}
        fields = tuple(track.get(k) for k in ('title', 'album', 'artist', 'service', 'source', 'quality', 'zone'))
        urls = tuple((assets.get(k) or (None,))[0] for k in ('art', 'qr', 'wifiQR'))
        return (bool(status), status.get('phase'), fields, urls, setup.get('pin'), setup.get('url'), error, self.surface.get_size())

    def present(self, state):
        """Draw what changed; returns None for a full repaint, else a list of dirty logical rects."""
        sig = self.signature(state)
        if sig != self.sig:
            self.sig = sig
            self.draw(state)
            return None
        return self.paint_progress(state)

    def draw(self, state):
        status, setup, assets, error, updated = state
        screen = self.surface
        w, h = screen.get_size()
        unit = min(w, h) / 768
        bar = max(int(140 * unit), h // 4)
        art_h = h - bar
        scale = min(w, h)
        screen.fill(BAR_BG)
        track = status.get('track') or {}
        self.background(assets.get('art'), (w, h), pygame.Rect(0, art_h, w, bar))
        if not self.image('art', assets.get('art'), pygame.Rect(0, 0, w, art_h)):
            self.text('等待音樂播放' if status else '正在啟動 PiDisplay…', (w * .08, art_h * .42), scale * .04)
        if self.bg is None:
            pygame.draw.rect(screen, BAR_BG, (0, art_h, w, bar))
        pad = int(w * .04)
        text_width = w - pad * 2
        y = art_h + max(8, int(bar * .07))
        title_size = max(22, min(96, scale * .045))
        meta_size = max(15, min(60, scale * .027))
        self.text(track.get('title') or '等候音樂播放', (pad, y), title_size, width=text_width)
        y += int(title_size * 1.45)
        self.text(track.get('album') or '專輯名稱', (pad, y), meta_size, width=text_width)
        y += int(meta_size * 1.5)
        self.text(track.get('artist') or 'Sonos · Roon', (pad, y), meta_size, TEXT_DIM, text_width)
        self.paint_progress(state, clear=False)
        phase = status.get('phase')
        if phase == 'ready':
            _, _, _, _, _, size, base, _, right = self._geometry(state)
            if right:
                font = self.font(size)
                self.surface.blit(font.render(right, True, TEXT_DIM), (w - pad - font.size(right)[0], base[1]))
        elif phase in ('wifi', 'source'):
            panel_w = min(w - int(32 * unit), int(680 * unit))
            panel_h = min(art_h - int(16 * unit), int(360 * unit))
            panel = pygame.Rect((w - panel_w) // 2, int(12 * unit), panel_w, panel_h)
            pygame.draw.rect(screen, (20, 32, 25), panel, border_radius=12)
            pygame.draw.rect(screen, (82, 100, 78), panel, 1, border_radius=12)
            self.text('1 / 連上 Wi-Fi' if phase == 'wifi' else '2 / 連結 Sonos 或 Roon', (panel.x + int(18 * unit), panel.y + int(10 * unit)), 24 * unit, width=panel_w - int(36 * unit))
            self.text('手機掃碼設定，不需要滑鼠' if phase == 'wifi' else '用手機開啟下列網址，不需要滑鼠', (panel.x + int(18 * unit), panel.y + int(48 * unit)), 16 * unit, width=panel_w - int(36 * unit))
            codes = [('wifiQR', '① 連上設定熱點'), ('qr', '② 開啟設定頁')] if phase == 'wifi' else []
            codes = [(key, label) for key, label in codes if assets.get(key)]
            size = min(int(176 * unit), max(64, panel_h - int(145 * unit)), (panel_w - int(60 * unit)) // max(1, len(codes)))
            start = panel.centerx - (len(codes) * (size + int(24 * unit)) - int(24 * unit)) // 2
            for i, (key, label) in enumerate(codes):
                rect = pygame.Rect(start + i * (size + int(24 * unit)), panel.y + int(80 * unit), size, size)
                self.image(key, assets.get(key), rect, True)
                self.text(label, (rect.x, rect.bottom + int(5 * unit)), 14 * unit, width=size + int(12 * unit))
            if phase == 'wifi':
                self.text('配對碼 ' + str(setup.get('pin', '')), (panel.x + int(18 * unit), panel.bottom - int(37 * unit)), 20 * unit)
            else:
                self.text('選擇播放來源', (panel.x + int(18 * unit), panel.y + int(80 * unit)), 16 * unit)
                self.text(self.setup_line(setup, 16 * unit, panel_w - int(36 * unit)), (panel.x + int(18 * unit), panel.y + int(110 * unit)), 16 * unit, TEXT_DIM)


ROTATIONS = ('normal', 'left', 'right', 'inverted')
# X no longer rotates the screen (kiosk.sh always uses xrandr --rotate normal); the same orientation is applied here.
# xrandr "--rotate right" turns the picture clockwise by 90 degrees: the logical top edge ends up on the panel's right.
# "left" = counter-clockwise 90, "inverted" = 180. pygame.transform.rotate takes counter-clockwise degrees.
ROTATE_DEGREES = {'normal': 0, 'left': 90, 'right': -90, 'inverted': 180}


def logical_size(phys_size, rotation):
    w, h = phys_size
    return (h, w) if rotation in ('left', 'right') else (w, h)


def physical_rect(rect, rotation, phys_size):
    """Map a rect on the logical canvas to the rect it occupies on the physical canvas."""
    pw, ph = phys_size
    x, y, w, h = rect
    if rotation == 'right':
        return pygame.Rect(pw - y - h, x, h, w)
    if rotation == 'left':
        return pygame.Rect(y, ph - x - w, h, w)
    if rotation == 'inverted':
        return pygame.Rect(pw - x - w, ph - y - h, w, h)
    return pygame.Rect(x, y, w, h)


class Presenter:
    """Logical canvas -> physical screen; sends only the changed regions."""

    def __init__(self, physical, rotation='normal'):
        self.physical = physical
        self.rotation = rotation if rotation in ROTATIONS else 'normal'
        size = logical_size(physical.get_size(), self.rotation)
        self.logical = physical if self.rotation == 'normal' else pygame.Surface(size, 0, physical)
        self.display = Display(self.logical)
        self.stats = {'full': 0, 'partial': 0, 'pixels': 0, 'last_pixels': 0}

    def frame(self, state):
        """Draw if needed and return the physical rects to push to the screen (empty list when nothing changed)."""
        rects = self.display.present(state)
        lw, lh = self.logical.get_size()
        full = rects is None
        if full:
            rects = [pygame.Rect(0, 0, lw, lh)]
        out = []
        for rect in rects:
            rect = pygame.Rect(rect).clip(pygame.Rect(0, 0, lw, lh))
            if rect.width <= 0 or rect.height <= 0:
                continue
            target = physical_rect(rect, self.rotation, self.physical.get_size())
            if self.rotation != 'normal':
                piece = pygame.transform.rotate(self.logical.subsurface(rect), ROTATE_DEGREES[self.rotation])
                self.physical.blit(piece, target.topleft)
                del piece
            out.append(target)
        pixels = sum(r.width * r.height for r in out)
        if full:
            self.stats['full'] += 1
        elif out:
            self.stats['partial'] += 1
            self.stats['pixels'] += pixels
        self.stats['last_pixels'] = pixels
        return out


def env_rotation():
    value = os.environ.get('PIDISPLAY_ROTATION') or 'normal'
    return value if value in ROTATIONS else 'normal'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot')
    parser.add_argument('--size', default='1024x768')
    args = parser.parse_args()
    if args.snapshot:
        os.environ.setdefault('SDL_VIDEODRIVER', 'dummy')
    pygame.display.init()
    pygame.font.init()
    size = tuple(map(int, args.size.split('x'))) if args.snapshot else (0, 0)
    surface = pygame.display.set_mode(size, 0 if args.snapshot else pygame.FULLSCREEN)
    pygame.display.set_caption('PiDisplay')
    pygame.mouse.set_visible(False)
    feed = Feed()
    if args.snapshot:
        display = Display(surface)
        feed.update()
        display.draw(feed.snapshot())
        pygame.image.save(surface, args.snapshot)
        return
    presenter = Presenter(surface, env_rotation())
    stats_on = os.environ.get('PIDISPLAY_STATS') == '1'
    next_stats = time.monotonic() + 60
    stop = threading.Event()
    threading.Thread(target=feed.run, args=(stop,), daemon=True).start()
    try:
        clock = pygame.time.Clock()
        while True:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
            rects = presenter.frame(feed.snapshot())
            if rects:
                pygame.display.update(rects)
            if stats_on and time.monotonic() >= next_stats:
                next_stats += 60
                st = presenter.stats
                print(f"pidisplay stats full={st['full']} partial={st['partial']} partial_pixels={st['pixels']}", file=sys.stderr, flush=True)
            clock.tick(2)
    finally:
        stop.set()
        pygame.quit()


if __name__ == '__main__':
    main()
