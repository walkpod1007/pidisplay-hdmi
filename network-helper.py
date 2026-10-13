#!/usr/bin/python3
"""Root-owned, fixed-path helper. JSON stdin; never executes a shell."""
import configparser, json, os, subprocess, sys, tempfile, uuid
from pathlib import Path
NM = '/usr/bin/nmcli'
HOTSPOT_ID = 'pidisplay-setup'
IFACE = 'wlan0'

def run(*args, timeout=20):
    return subprocess.run([NM, *args], check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()

def status():
    active = run('-g', 'GENERAL.CONNECTION', 'device', 'show', IFACE)
    state = run('-g', 'GENERAL.STATE', 'device', 'show', IFACE)
    up = state.startswith('100')
    return {'available': True, 'connected': up and active != HOTSPOT_ID, 'hotspot': up and active == HOTSPOT_ID}

def escape(value):
    return value.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t').replace(' ', '\\s')

def profile(ssid, password, hotspot=False):
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32 or '\x00' in ssid:
        raise ValueError('ssid')
    if not isinstance(password, str) or '\x00' in password or (password and not (8 <= len(password.encode()) <= 63 or len(password) == 64 and all(c in '0123456789abcdefABCDEF' for c in password))):
        raise ValueError('password')
    ident = HOTSPOT_ID if hotspot else 'pidisplay-wifi-' + uuid.uuid4().hex[:10]
    uid = str(uuid.uuid4())
    text = f'[connection]\nid={ident}\nuuid={uid}\ntype=wifi\ninterface-name={IFACE}\nautoconnect={"false" if hotspot else "true"}\nautoconnect-priority=20\n\n[wifi]\nmode={"ap" if hotspot else "infrastructure"}\nssid=' + ''.join(f'{b};' for b in ssid.encode()) + '\n'
    if hotspot: text += 'band=bg\n'
    if password: text += '\n[wifi-security]\nkey-mgmt=wpa-psk\npsk=' + escape(password) + '\n'
    text += '\n[ipv4]\nmethod=' + ('shared\naddress1=10.42.0.1/24' if hotspot else 'auto') + '\n\n[ipv6]\nmethod=disabled\n'
    return uid, text

def load_profile(ssid, password, hotspot=False):
    uid, content = profile(ssid, password, hotspot)
    # Unique file: never replace an existing network profile.
    target = Path('/etc/NetworkManager/system-connections') / (uid + '.nmconnection')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(content)
    run('connection', 'load', str(target))
    return uid

def hotspot(password):
    # Find only the profile created by this helper, not an arbitrary same-name connection.
    found = None
    for f in Path('/etc/NetworkManager/system-connections').glob('*.nmconnection'):
        settings = configparser.ConfigParser(interpolation=None)
        try:
            settings.read_string(f.read_text())
            connection = settings['connection']
            if (connection.get('id') == HOTSPOT_ID
                    and connection.get('interface-name') == IFACE
                    and connection.get('type') in ('wifi', '802-11-wireless')
                    and settings.get('wifi', 'mode', fallback='') == 'ap'):
                found = str(uuid.UUID(connection['uuid']))
                break
        except (OSError, UnicodeError, configparser.Error, KeyError, ValueError):
            continue
    if not found: found = load_profile('PiDisplay-Setup', password, True)
    run('--wait', '20', 'connection', 'up', 'uuid', found, timeout=25)
    return status()

def main():
    os.umask(0o077)
    data = json.loads(sys.stdin.read(8193))
    action = data.get('action')
    if action == 'status': result = status()
    elif action == 'scan':
        raw = run('--escape', 'no', '-g', 'SSID', 'device', 'wifi', 'list', 'ifname', IFACE)
        result = {'networks': sorted(set(s for s in raw.splitlines() if s))}
    elif action == 'hotspot': result = hotspot(data['hotspotPassword'])
    elif action == 'connect':
        # Validate everything before switching networks; failed profiles remain disabled.
        profile('PiDisplay-Setup', data['hotspotPassword'], True)
        uid = load_profile(data['ssid'], data['password'])
        try:
            run('--wait', '25', 'connection', 'up', 'uuid', uid, timeout=30)
            result = status()
            if not result['connected']: raise RuntimeError('not connected')
        except Exception:
            try:
                run('connection', 'modify', 'uuid', uid, 'connection.autoconnect', 'no')
            finally:
                # Recovery must still run if disabling the failed profile errors.
                hotspot(data['hotspotPassword'])
            raise RuntimeError('connection failed')
    else: raise ValueError('unsupported action')
    print(json.dumps(result))

if __name__ == '__main__':
    try: main()
    except Exception:
        print(json.dumps({'error': 'Network operation failed'}))
        sys.exit(1)
