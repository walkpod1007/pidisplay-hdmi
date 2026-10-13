import os
os.environ['SDL_VIDEODRIVER'] = 'dummy'
import importlib.util
import io
import json
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_display', Path(__file__).with_name('native-display.py'))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)


class FeedTests(unittest.TestCase):
    def test_failed_cover_is_retried_without_track_change(self):
        feed = ui.Feed()
        def response(url):
            if url.endswith('/api/status'):
                return b'{"phase":"ready","track":{"title":"Song","art":"/cover"}}'
            if url.endswith('/api/local-setup'):
                return b'{}'
            raise OSError('temporary image failure')
        with patch.object(ui, 'fetch', side_effect=response):
            feed.update()
        self.assertEqual(feed.status['track']['title'], 'Song')
        self.assertNotIn('art', feed.assets)
        with patch.object(ui, 'fetch', side_effect=lambda url: b'image' if url.endswith('/cover') else response(url)):
            feed.update()
        self.assertEqual(feed.assets['art'][1], b'image')

    def test_disconnect_keeps_last_frame_with_error_flag(self):
        feed = ui.Feed()
        feed.status = {'phase': 'ready', 'track': {'title': 'Last song'}}
        with patch.object(ui, 'fetch', side_effect=OSError('offline')):
            feed.update()
        self.assertTrue(feed.error)
        self.assertEqual(feed.status['track']['title'], 'Last song')


class LayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ui.pygame.display.init()
        ui.pygame.font.init()

    def test_portrait_landscape_and_onboarding_render(self):
        image = ui.pygame.Surface((64, 64))
        image.fill((160, 70, 20))
        data = io.BytesIO()
        ui.pygame.image.save(image, data, 'cover.png')
        asset = ('fixture', data.getvalue())
        assets = {key: asset for key in ('art', 'qr', 'wifiQR')}
        for size in ((1024, 768), (768, 1024), (1280, 720), (640, 480), (2048, 1536), (1536, 2048)):
            surface = ui.pygame.display.set_mode(size)
            for phase in ('ready', 'wifi', 'source'):
                with self.subTest(size=size, phase=phase):
                    display = ui.Display(surface)
                    state = ({'phase': phase, 'track': {'title': '測試超長歌名' * 20, 'album': '專輯', 'artist': '歌手', 'duration': 60000, 'progress': 10000}}, {'pin': '123456'}, assets, False, time.monotonic())
                    display.draw(state)
                    self.assertEqual(surface.get_at((size[0]//2, size[1]-1))[:3], (38, 50, 41))
                    self.assertIn('art', display.images)
                    if phase == 'wifi':
                        self.assertIn('qr', display.images)
                        self.assertIn('wifiQR', display.images)
                    else:
                        self.assertNotIn('qr', display.images)
                        self.assertNotIn('wifiQR', display.images)
                    display.draw(({}, {}, {}, True, time.monotonic()))
                    self.assertNotIn('art', display.images)


def png(color, size=(64, 64), stripes=False):
    image = ui.pygame.Surface(size)
    image.fill(color)
    if stripes:
        for x in range(0, size[0], 8):
            image.fill((255, 255, 255) if x % 16 else (0, 0, 0), (x, 0, 4, size[1]))
    data = io.BytesIO()
    ui.pygame.image.save(image, data, 'cover.png')
    return data.getvalue()


class MetaLabelTests(unittest.TestCase):
    def test_parts_are_skipped_without_stray_separators(self):
        self.assertEqual(ui.meta_label({'service': 'Apple Music', 'quality': 'AAC 256 kbps', 'zone': '書房'}), 'Apple Music · AAC 256 kbps · 書房')
        self.assertEqual(ui.meta_label({'source': 'Sonos', 'zone': '書房'}), 'Sonos · 書房')
        self.assertEqual(ui.meta_label({'service': 'Tidal', 'source': 'Sonos', 'quality': 'FLAC'}), 'Tidal · FLAC')
        self.assertEqual(ui.meta_label({'source': 'Roon'}), 'Roon')
        self.assertEqual(ui.meta_label({}), 'NOW PLAYING')


class FetchTimeoutTests(unittest.TestCase):
    def test_cover_gets_ten_seconds_status_keeps_five(self):
        seen = {}
        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return b'x'
        def fake(url, timeout):
            seen[url] = timeout
            return Resp()
        with patch.object(ui.urllib.request, 'urlopen', side_effect=fake):
            ui.fetch('http://h/api/sonos-art/G?v=1')
            ui.fetch('http://h/api/roon-art/k')
            ui.fetch('http://h/api/status')
        self.assertEqual(seen, {'http://h/api/sonos-art/G?v=1': 10, 'http://h/api/roon-art/k': 10, 'http://h/api/status': 5})


class MetaLineTests(unittest.TestCase):
    def test_dot_has_equal_space_on_both_sides(self):
        ui.pygame.display.init(); ui.pygame.font.init()
        surface = ui.pygame.display.set_mode((1200, 200))
        display = ui.Display(surface)
        surface.fill((0, 0, 0))
        display.meta_line(['AAA', 'BBB'], '', (100, 50), 40, 1000)
        font = ui.pygame.font.Font(ui.FONT, 40)
        gap = max(6, int(40 * .5))
        first_end = 100 + font.size('AAA')[0]
        second_start = first_end + gap * 2
        lit = {x for x in range(first_end + 1, second_start) for y in range(50, 100) if surface.get_at((x, y))[:3] == ui.TEXT_DIM}
        self.assertTrue(lit)
        left, right = min(lit) - first_end, second_start - max(lit)
        self.assertLessEqual(abs(left - right), 2)

    def test_very_long_text_is_cut_before_measuring(self):
        surface = ui.pygame.display.set_mode((800, 200))
        display = ui.Display(surface)
        t0 = time.perf_counter()
        display.text('字' * 5000, (0, 0), 30, width=700)
        self.assertLess(time.perf_counter() - t0, 0.5)

    def test_parts_skip_missing(self):
        self.assertEqual(ui.meta_parts({'source': 'Sonos', 'zone': '書房'}), ['Sonos', '書房'])


class BackgroundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ui.pygame.display.init()
        ui.pygame.font.init()

    def test_white_text_contrast_on_blurred_pixels_for_brightest_and_busy_covers(self):
        floor = ui.MIN_CONTRAST
        for size in ((1536, 2048), (2048, 1536), (640, 480)):
            ui.pygame.display.set_mode(size)
            w, h = size
            bar = ui.pygame.Rect(0, h - max(int(140 * min(w, h) / 768), h // 4), w, max(int(140 * min(w, h) / 768), h // 4))
            for name, data in (('white', png((255, 255, 255))), ('yellow', png((255, 255, 0))), ('striped', png((255, 255, 255), (96, 96), True))):
                with self.subTest(size=size, cover=name):
                    bg = ui.blurred_background(data, size, bar)
                    self.assertEqual(bg.get_size(), size)
                    worst = ui.region_max_luminance(bg, bar, 2)
                    lowest_text = min(ui.luminance(c) for c in (ui.TEXT, ui.TEXT_DIM))
                    self.assertGreaterEqual((lowest_text + 0.05) / (worst + 0.05), floor)
                    # actual pixel check with the real dimmest text colour
                    px = max((bg.get_at((x, y))[:3] for x in range(0, w, 37) for y in range(bar.top, h, 37)), key=ui.luminance)
                    self.assertGreaterEqual(ui.contrast(ui.TEXT_DIM, px), floor)

    def test_default_background_is_flat_and_holds_no_surface(self):
        surface = ui.pygame.display.set_mode((640, 480))
        display = ui.Display(surface)
        asset = ('u1', png((200, 40, 40)))
        state = ({'phase': 'ready', 'track': {'title': 'x'}}, {}, {'art': asset}, False, time.monotonic())
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PIDISPLAY_BG', None)
            with patch.object(ui, 'blurred_background') as spy:
                display.draw(state); display.draw(state)
                spy.assert_not_called()
        self.assertIsNone(display.bg)
        for xy in ((10, 470), (320, 400), (630, 470)):
            self.assertEqual(surface.get_at(xy)[:3], ui.BAR_BG)
        self.assertEqual(ui.BAR_BG, (16, 24, 20))
        self.assertTrue(all(c % 4 == 0 for c in ui.BAR_BG))

    def test_text_contrast_on_flat_bar(self):
        self.assertGreaterEqual(ui.contrast(ui.TEXT_DIM, ui.BAR_BG), ui.MIN_CONTRAST)
        self.assertGreaterEqual(ui.contrast(ui.TEXT, ui.BAR_BG), ui.MIN_CONTRAST)

    @patch.dict(os.environ, {'PIDISPLAY_BG': 'blur'})
    def test_background_is_cached_and_cleared(self):
        surface = ui.pygame.display.set_mode((640, 480))
        display = ui.Display(surface)
        asset = ('u1', png((200, 40, 40)))
        state = ({'phase': 'ready', 'track': {'title': 'x'}}, {}, {'art': asset}, False, time.monotonic())
        with patch.object(ui, 'blurred_background', wraps=ui.blurred_background) as spy:
            display.draw(state); display.draw(state); display.draw(state)
            self.assertEqual(spy.call_count, 1)
        self.assertIsNotNone(display.bg)
        display.draw(({'phase': 'ready', 'track': {}}, {}, {}, False, time.monotonic()))
        self.assertIsNone(display.bg)
        self.assertEqual(surface.get_at((10, 470))[:3], ui.BAR_BG)

    @patch.dict(os.environ, {'PIDISPLAY_BG': 'blur'})
    def test_bad_cover_falls_back_to_plain_dark_without_retrying(self):
        surface = ui.pygame.display.set_mode((640, 480))
        display = ui.Display(surface)
        state = ({'phase': 'ready', 'track': {}}, {}, {'art': ('bad', b'notanimage')}, False, time.monotonic())
        with patch.object(ui, 'blurred_background', side_effect=ui.pygame.error('bad')) as spy:
            display.draw(state); display.draw(state)
            self.assertEqual(spy.call_count, 1)
        self.assertEqual(surface.get_at((10, 470))[:3], ui.BAR_BG)

    @patch.dict(os.environ, {'PIDISPLAY_BG': 'blur'})
    def test_qr_stays_white_on_blurred_background_in_wifi_setup(self):
        surface = ui.pygame.display.set_mode((1536, 2048))
        display = ui.Display(surface)
        state = ({'phase': 'wifi', 'track': {'title': 'x'}}, {'pin': '1'}, {'art': ('u', png((20, 20, 20))), 'qr': ('q', png((255, 255, 255))), 'wifiQR': ('w', png((255, 255, 255)))}, False, time.monotonic())
        display.draw(state)
        self.assertIn('qr', display.images)
        self.assertTrue(any(surface.get_at((x, y))[:3] == (255, 255, 255) for x in range(300, 1236, 20) for y in range(150, 600, 20)))


URL_SETUP = {'pin': '511255', 'url': 'http://192.168.4.63:8787/setup'}


def band_bbox(surface, x0, x1, y0, y1):
    xs = [x for x in range(x0, x1) for y in range(y0, y1) if surface.get_at((x, y))[:3] != ui.BAR_BG]
    return (min(xs), max(xs)) if xs else None


class SetupLineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ui.pygame.display.init()
        ui.pygame.font.init()

    def ready(self, size=(1536, 2048), setup=URL_SETUP, track=None):
        surface = ui.pygame.display.set_mode(size)
        display = ui.Display(surface)
        track = track or {'title': 'x', 'album': 'a', 'artist': 'b', 'service': 'Apple Music', 'duration': 60000, 'progress': 10000}
        state = ({'phase': 'ready', 'track': track}, setup, {'art': ('u', png((200, 40, 40))), 'qr': ('q', png((255, 255, 255)))}, False, time.monotonic())
        display.draw(state)
        return surface, display, state

    def test_ready_has_no_qr_and_prints_url_and_pin_bottom_right(self):
        for size in ((1536, 2048), (2048, 1536), (640, 480)):
            with self.subTest(size=size):
                surface, display, state = self.ready(size)
                w, h = size
                self.assertNotIn('qr', display.images)
                w_, h_, unit, pad, text_width, fsize, base, label_rect, right = display._geometry(state)
                self.assertEqual(right, '192.168.4.63:8787/setup · 配對碼 511255')
                band = (base[1], min(base[1] + int(fsize * 1.4), h - 4))
                box = band_bbox(surface, w // 2, w, *band)
                self.assertIsNotNone(box)
                self.assertLessEqual(box[1], w - pad)
                left = band_bbox(surface, 0, w // 2, *band)
                self.assertLess(left[1], box[0])
                self.assertLessEqual(label_rect.right, box[0] + 1)
                px = max((surface.get_at((x, y))[:3] for x in range(box[0], box[1] + 1) for y in range(*band)), key=ui.luminance)
                self.assertGreaterEqual(ui.contrast(px, ui.BAR_BG), ui.MIN_CONTRAST)

    def test_long_url_is_cut_but_pin_stays_and_never_crosses_left_line(self):
        long = {'pin': '511255', 'url': 'http://' + 'very-long-host-name.example.com/' * 8}
        surface, display, state = self.ready((1024, 768), long, {'title': 'x', 'album': 'a', 'artist': 'b', 'service': 'Apple Music', 'quality': 'FLAC 24-bit', 'zone': '書房', 'duration': 60000, 'progress': 10000})
        w, h, unit, pad, text_width, fsize, base, label_rect, right = display._geometry(state)
        self.assertTrue(right.endswith('配對碼 511255'))
        self.assertIn('…', right)
        self.assertLessEqual(display.font(fsize).size(right)[0], (w - pad * 2) * .45)
        band = (base[1], min(base[1] + int(fsize * 1.4), h - 4))
        box = band_bbox(surface, w // 2, w, *band)
        left = band_bbox(surface, 0, w // 2, *band)
        self.assertLess(left[1], box[0])

    def test_no_url_or_pin_degrades_without_error(self):
        surface, display, state = self.ready(setup={'pin': '9'})
        self.assertEqual(display._geometry(state)[-1], '配對碼 9')
        surface, display, state = self.ready(setup={})
        self.assertEqual(display._geometry(state)[-1], '')

    def test_source_phase_prints_url_not_qr(self):
        surface = ui.pygame.display.set_mode((1536, 2048))
        display = ui.Display(surface)
        state = ({'phase': 'source', 'track': {}}, URL_SETUP, {'art': ('u', png((20, 20, 20))), 'qr': ('q', png((255, 255, 255)))}, False, time.monotonic())
        display.draw(state)
        self.assertNotIn('qr', display.images)
        self.assertEqual(display.setup_line(URL_SETUP, 16, 10000), '192.168.4.63:8787/setup · 配對碼 511255')

    def test_url_change_forces_full_repaint(self):
        surface, display, state = self.ready()
        self.assertIsNone(display.present(state))
        self.assertIsNotNone(display.present(state))
        changed = (state[0], {**URL_SETUP, 'url': 'http://192.168.4.99:8787/setup'}, *state[2:])
        self.assertIsNone(display.present(changed))

    def test_feed_fetches_qr_only_in_wifi_phase(self):
        for phase, expect in (('ready', False), ('source', False), ('wifi', True)):
            requested = []
            def fake(url, limit=0, phase=phase):
                requested.append(url)
                if url.endswith('/api/status'):
                    return json.dumps({'phase': phase, 'track': {}}).encode()
                if url.endswith('/api/local-setup'):
                    return json.dumps({'pin': '1', 'url': 'http://h/setup', 'qr': '/q.png', 'wifiQR': '/w.png'}).encode()
                return b'png'
            feed = ui.Feed()
            with patch.object(ui, 'fetch', fake):
                feed.update()
            self.assertEqual(any(u.endswith('/q.png') for u in requested), expect, phase)
            self.assertEqual('qr' in feed.assets, expect, phase)


class RotationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ui.pygame.display.init()
        ui.pygame.font.init()

    # Expected corner of the PHYSICAL canvas for each LOGICAL corner.
    # xrandr "--rotate right" turns the picture clockwise by 90 degrees (logical top edge ends on the panel's right),
    # "left" counter-clockwise 90, "inverted" 180.
    EXPECTED = {
        'normal':   {'TL': 'TL', 'TR': 'TR', 'BL': 'BL', 'BR': 'BR'},
        'right':    {'TL': 'TR', 'TR': 'BR', 'BL': 'TL', 'BR': 'BL'},
        'left':     {'TL': 'BL', 'TR': 'TL', 'BL': 'BR', 'BR': 'TR'},
        'inverted': {'TL': 'BR', 'TR': 'BL', 'BL': 'TR', 'BR': 'TL'},
    }
    COLORS = {'TL': (255, 0, 0), 'TR': (0, 255, 0), 'BL': (0, 0, 255), 'BR': (255, 255, 0)}

    def test_corner_colours_land_on_the_expected_physical_corner(self):
        for rotation, mapping in self.EXPECTED.items():
            with self.subTest(rotation=rotation):
                phys = ui.pygame.display.set_mode((200, 120))
                presenter = ui.Presenter(phys, rotation)
                lw, lh = presenter.logical.get_size()
                self.assertEqual((lw, lh), (120, 200) if rotation in ('left', 'right') else (200, 120))
                def paint(state):
                    pts = {'TL': (0, 0), 'TR': (lw - 8, 0), 'BL': (0, lh - 8), 'BR': (lw - 8, lh - 8)}
                    presenter.logical.fill((0, 0, 0))
                    for name, (x, y) in pts.items():
                        presenter.logical.fill(self.COLORS[name], (x, y, 8, 8))
                    return None
                presenter.display.present = paint
                phys.fill((0, 0, 0))
                rects = presenter.frame(None)
                self.assertEqual(len(rects), 1)
                corners = {'TL': (2, 2), 'TR': (197, 2), 'BL': (2, 117), 'BR': (197, 117)}
                for logical_corner, physical_corner in mapping.items():
                    self.assertEqual(phys.get_at(corners[physical_corner])[:3], self.COLORS[logical_corner], (rotation, logical_corner))

    def test_rect_conversion_matches_point_conversion(self):
        pw, ph = 200, 120
        def point(x, y, rotation):
            return {'normal': (x, y), 'right': (pw - 1 - y, x), 'left': (y, ph - 1 - x), 'inverted': (pw - 1 - x, ph - 1 - y)}[rotation]
        for rotation in ui.ROTATIONS:
            lw, lh = ui.logical_size((pw, ph), rotation)
            for rect in ((0, 0, 10, 5), (30, 40, 25, 7), (lw - 9, lh - 4, 9, 4)):
                with self.subTest(rotation=rotation, rect=rect):
                    out = ui.physical_rect(rect, rotation, (pw, ph))
                    x, y, w, h = rect
                    pts = [point(px, py, rotation) for px in (x, x + w - 1) for py in (y, y + h - 1)]
                    self.assertEqual((min(p[0] for p in pts), min(p[1] for p in pts)), out.topleft)
                    self.assertEqual((max(p[0] for p in pts) + 1, max(p[1] for p in pts) + 1), out.bottomright)
                    self.assertEqual(out.width * out.height, w * h)

    def test_unknown_rotation_falls_back_to_normal(self):
        with patch.dict(os.environ, {'PIDISPLAY_ROTATION': 'sideways'}):
            self.assertEqual(ui.env_rotation(), 'normal')
        with patch.dict(os.environ, {'PIDISPLAY_ROTATION': 'right'}):
            self.assertEqual(ui.env_rotation(), 'right')

    def _states(self, count, art, qr, updated=None):
        out = []
        for i in range(count):
            status = {'phase': 'ready', 'track': {'title': '歌', 'album': '專輯', 'artist': '歌手', 'service': 'Apple Music', 'quality': '', 'zone': '書房', 'playing': True, 'progress': i * 500, 'duration': 300000}}
            out.append((status, {'pin': '123456', 'url': 'http://192.168.4.63:8787/setup'}, {'art': art, 'qr': qr}, False, updated if updated is not None else time.monotonic()))
        return out

    def test_sixty_seconds_of_playback_is_one_full_repaint_and_small_partials(self):
        asset = ('cover', png((180, 90, 30), (200, 200), True))
        qr = ('qr', png((255, 255, 255)))
        for rotation, size in (('normal', (1536, 2048)), ('right', (2048, 1536))):
            with self.subTest(rotation=rotation):
                phys = ui.pygame.display.set_mode(size)
                presenter = ui.Presenter(phys, rotation)
                total = presenter.logical.get_width() * presenter.logical.get_height()
                for state in self._states(120, asset, qr):
                    before = dict(presenter.stats)
                    presenter.frame(state)
                    if presenter.stats['partial'] > before['partial']:
                        self.assertLessEqual(presenter.stats['last_pixels'], total * 0.05)
                self.assertLessEqual(presenter.stats['full'], 2)
                self.assertGreater(presenter.stats['partial'], 0)

    def test_paused_or_unchanged_state_sends_nothing(self):
        phys = ui.pygame.display.set_mode((640, 480))
        presenter = ui.Presenter(phys, 'normal')
        status = {'phase': 'ready', 'track': {'title': 'x', 'playing': False, 'progress': 5000, 'duration': 60000}}
        first = presenter.frame(({**status}, {'pin': '1'}, {}, False, time.monotonic()))
        self.assertTrue(first)
        for _ in range(5):
            self.assertEqual(presenter.frame(({**status}, {'pin': '1'}, {}, False, time.monotonic())), [])
        self.assertEqual(presenter.stats['full'], 1)
        self.assertEqual(presenter.stats['partial'], 0)

    @patch.object(ui.time, 'monotonic', return_value=1000.0)
    def test_partial_update_is_pixel_identical_to_a_full_repaint(self, _clock):
        asset = ('cover', png((60, 120, 200), (200, 200), True))
        states = self._states(40, asset, ('qr', png((255, 255, 255))), updated=1000.0)
        for rotation, size in (('right', (2048, 1536)), ('left', (2048, 1536)), ('inverted', (640, 480)), ('normal', (640, 480))):
            with self.subTest(rotation=rotation):
                phys = ui.pygame.display.set_mode(size)
                incremental = ui.Presenter(phys, rotation)
                for state in states[:39]:
                    incremental.frame(state)
                incremental.frame(states[39])
                got = ui.pygame.image.tostring(phys, 'RGB')
                phys2 = ui.pygame.display.set_mode(size)
                fresh = ui.Presenter(phys2, rotation)
                fresh.frame(states[39])
                self.assertEqual(got == ui.pygame.image.tostring(phys2, 'RGB'), True)


if __name__ == '__main__':
    unittest.main()
