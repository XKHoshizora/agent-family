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


# --- Agent Family single sign-on (standard Synapse OIDC; disabled by default) ---
# Identity mapping: OIDC `sub` = immutable AF user id; the Matrix localpart comes
# ONLY from the AF-computed `af_localpart` claim (the same deterministic value AF
# already used for shared-secret provisioning), so existing @af_...:server users
# keep their ID, history and crypto. Email is never requested or used to match.
AF_IDP_IDS = {'agent-family', 'oidc-agent-family'}


def _https_url(name, value, path=None):
    from urllib.parse import urlsplit
    if not value:
        raise RuntimeError(f'{name} is required when SYNAPSE_OIDC_ENABLED=true')
    parts = urlsplit(value)
    if parts.scheme != 'https' or not parts.hostname:
        raise RuntimeError(f'{name} must be an https URL')
    if parts.username or parts.password or parts.query or parts.fragment:
        raise RuntimeError(f'{name} must not contain credentials, query or fragment')
    if path is not None and parts.path.rstrip('/') != path:
        raise RuntimeError(f'{name} must have path {path}')
    return parts


def agent_family_oidc_provider():
    issuer = os.environ.get('SYNAPSE_OIDC_ISSUER', '')
    _https_url('SYNAPSE_OIDC_ISSUER', issuer, '/api/auth')
    issuer = issuer.rstrip('/')
    client_id = os.environ.get('SYNAPSE_OIDC_CLIENT_ID', '')
    client_secret = os.environ.get('SYNAPSE_OIDC_CLIENT_SECRET', '')
    if not client_id or len(client_secret) < 32:
        raise RuntimeError('SYNAPSE_OIDC_CLIENT_ID and a >=32 character SYNAPSE_OIDC_CLIENT_SECRET are required')
    public = config['public_baseurl']
    _https_url('SYNAPSE_PUBLIC_BASEURL', public)
    callback = public.rstrip('/') + '/_synapse/client/oidc/callback'
    expected = os.environ.get('SYNAPSE_OIDC_EXPECTED_REDIRECT_URI', '')
    if expected and expected != callback:
        # AF registers MATRIX_HOMESERVER_URL + /_synapse/client/oidc/callback; they must agree.
        raise RuntimeError('SYNAPSE_OIDC_EXPECTED_REDIRECT_URI does not match public_baseurl callback')
    return {
        'idp_id': 'agent-family',
        'idp_name': os.environ.get('SYNAPSE_OIDC_IDP_NAME', 'Agent Family'),
        'issuer': issuer,
        'discover': True,
        'skip_verification': False,
        'client_id': client_id,
        'client_secret': client_secret,
        'client_auth_method': 'client_secret_basic',
        'pkce_method': 'always',
        'scopes': ['openid', 'profile'],
        'user_profile_method': 'auto',
        # Required to attach the OIDC subject to the EXISTING deterministic
        # Matrix user; safe only because the localpart is never user-chosen.
        'allow_existing_users': True,
        # Fail closed: by default only users who already have their AF Matrix
        # account may sign in; set true to let SSO create the deterministic user.
        'enable_registration': os.environ.get('SYNAPSE_OIDC_ENABLE_REGISTRATION', 'false') == 'true',
        'backchannel_logout_enabled': False,
        'user_mapping_provider': {'config': {
            'subject_claim': 'sub',
            'localpart_template': '{{ user.af_localpart }}',
            'display_name_template': '{{ user.name }}',
            'confirm_localpart': False,
        }},
    }


oidc_enabled = os.environ.get('SYNAPSE_OIDC_ENABLED', 'false')
if oidc_enabled not in ('true', 'false'):
    raise RuntimeError('SYNAPSE_OIDC_ENABLED must be true or false')
providers = [p for p in (config.get('oidc_providers') or [])
             if not (isinstance(p, dict) and p.get('idp_id') in AF_IDP_IDS)]
if oidc_enabled == 'true':
    providers.append(agent_family_oidc_provider())
    whitelist = [u.strip() for u in os.environ.get('SYNAPSE_SSO_CLIENT_WHITELIST', '').split(',') if u.strip()]
    for entry in whitelist:
        _https_url('SYNAPSE_SSO_CLIENT_WHITELIST entry', entry)
    if whitelist:
        config['sso'] = {**(config.get('sso') or {}), 'client_whitelist': whitelist}
if providers:
    config['oidc_providers'] = providers
else:
    config.pop('oidc_providers', None)

temp = data / 'homeserver.yaml.new'
temp.write_text(yaml.safe_dump(config, sort_keys=False))
temp.chmod(0o600)
if hasattr(os, 'chown'):
    os.chown(temp, 991, 991)
temp.replace(config_file)
os.execv(sys.executable, [sys.executable, '/start.py', 'run'])
