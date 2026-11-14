"""Small configuration wrapper; all Matrix protocol/storage is upstream Synapse."""
import os
import pathlib
import subprocess
import sys
import yaml

data = pathlib.Path('/data')
data.mkdir(parents=True, exist_ok=True)
config_file = data / 'homeserver.yaml'
os.environ.setdefault('SYNAPSE_CONFIG_PATH', str(config_file))
os.environ.setdefault('SYNAPSE_REPORT_STATS', 'no')
if not config_file.exists():
    subprocess.run([sys.executable, '/start.py', 'generate'], check=True)
config = yaml.safe_load(config_file.read_text())
expected = os.environ['SYNAPSE_SERVER_NAME']
if config['server_name'] != expected:
    raise RuntimeError('Refusing to change an existing Matrix server identity')
config.update({
    'public_baseurl': os.environ['SYNAPSE_PUBLIC_BASEURL'],
    'serve_server_wellknown': True,
    'listeners': [{'port': int(os.environ.get('PORT', '8008')), 'tls': False,
                   'type': 'http', 'x_forwarded': True, 'bind_addresses': ['::', '0.0.0.0'],
                   'resources': [{'names': ['client', 'federation'], 'compress': False}]}],
    'database': {'name': 'psycopg2', 'args': {
        'host': os.environ['SYNAPSE_POSTGRES_HOST'], 'port': 5432,
        'user': os.environ['SYNAPSE_POSTGRES_USER'],
        'password': os.environ['SYNAPSE_POSTGRES_PASSWORD'],
        'database': os.environ['SYNAPSE_POSTGRES_DATABASE'],
        'cp_min': 2, 'cp_max': 5}},
    'enable_registration': False,
    'registration_shared_secret': os.environ['SYNAPSE_REGISTRATION_SHARED_SECRET'],
    'allow_guest_access': False,
    'allow_public_rooms_without_auth': False,
    'allow_public_rooms_over_federation': False,
    'encryption_enabled_by_default_for_room_type': 'all',
    'max_upload_size': '10M',
    'url_preview_enabled': False,
    'report_stats': False,
    'suppress_key_server_warning': True,
})
temp = data / 'homeserver.yaml.new'
temp.write_text(yaml.safe_dump(config, sort_keys=False))
temp.chmod(0o600)
if hasattr(os, 'chown'):
    os.chown(temp, 991, 991)
temp.replace(config_file)
os.execv(sys.executable, [sys.executable, '/start.py', 'run'])
