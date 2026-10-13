import importlib.util, unittest, io, json, tempfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('network','network-helper.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NetworkTests(unittest.TestCase):
    def test_hotspot_reuses_reordered_profile_and_stored_uuid(self):
        uid = '12345678-1234-4234-8234-123456789abc'
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'renamed-by-networkmanager.nmconnection'
            p.write_text('[wifi]\nmode=ap\n\n[connection]\nuuid='+uid+'\ntype=wifi\ninterface-name=wlan0\nid=pidisplay-setup\n')
            with patch.object(m.Path, 'glob', return_value=[p]), patch.object(m, 'run') as run, patch.object(m, 'status', return_value={'hotspot':True}), patch.object(m, 'load_profile') as create:
                self.assertTrue(m.hotspot('12345678')['hotspot'])
                create.assert_not_called()
                run.assert_called_once_with('--wait','20','connection','up','uuid',uid,timeout=25)

    def test_failed_disable_still_restores_setup_hotspot(self):
        request = json.dumps({'action':'connect','ssid':'room','password':'12345678','hotspotPassword':'87654321'})
        with patch.object(m.sys, 'stdin', io.StringIO(request)), patch.object(m.os, 'umask'), patch.object(m, 'load_profile', return_value='new-profile'), patch.object(m, 'run', side_effect=RuntimeError('nmcli failed')), patch.object(m, 'hotspot') as restore:
            with self.assertRaises(RuntimeError): m.main()
            restore.assert_called_once_with('87654321')

    def test_profile_injection_and_ssid_encoding(self):
        uid,text=m.profile('room\n[evil]','abc\n12345')
        self.assertNotIn('\n[evil]',text)
        self.assertIn('psk=abc\\n12345',text)
        self.assertIn('ssid=114;111;111;109;10;',text)
    def test_password_validation(self):
        for p in ['short','x'*64,'abc\x001234']:
            with self.assertRaises(ValueError): m.profile('room',p)
        m.profile('room','a'*64)
        m.profile('room','')
    def test_multibyte_ssid_limit(self):
        with self.assertRaises(ValueError):m.profile('房'*11,'12345678')
    def test_hotspot_does_not_autoconnect(self):
        _,text=m.profile('PiDisplay-Setup','12345678',True)
        self.assertIn('autoconnect=false',text)
        self.assertIn('method=shared',text)
        self.assertIn('address1=10.42.0.1/24',text)
if __name__=='__main__':unittest.main()
