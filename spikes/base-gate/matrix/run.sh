#!/usr/bin/env bash
# Gate-verification spike: bring up candidate A (Synapse, single server, no E2EE) in the sandbox.
# Secrets are generated on the sandbox and never leave it.
set -euo pipefail
cd /work/matrix
IMG=ghcr.io/element-hq/synapse:v1.165.0

if [ ! -f secrets.env ]; then
  { echo "REG_SECRET=$(openssl rand -hex 24)"; echo "AS_TOKEN=$(openssl rand -hex 24)"; echo "HS_TOKEN=$(openssl rand -hex 24)"; } > secrets.env
fi
. ./secrets.env

if ! grep -q 'af-gate-spike' data/homeserver.yaml; then
cat >> data/homeserver.yaml <<EOF

# --- af-gate-spike ---
enable_registration: false
registration_shared_secret: "$REG_SECRET"
federation_domain_whitelist: []
encryption_enabled_by_default_for_room_type: "off"
enable_authenticated_media: true
app_service_config_files:
  - /data/appservice.yaml
modules:
  - module: af_gate.AfGate
    config:
      rules_url: "http://127.0.0.1:9100"
      system_user: "@af_system:af.test"
      timeout: 2
rc_message: {per_second: 1000, burst_count: 1000}
rc_login:
  address: {per_second: 1000, burst_count: 1000}
  account: {per_second: 1000, burst_count: 1000}
rc_joins:
  local: {per_second: 1000, burst_count: 1000}
rc_invites:
  per_room: {per_second: 1000, burst_count: 1000}
  per_user: {per_second: 1000, burst_count: 1000}
EOF
fi

cat > data/appservice.yaml <<EOF
id: agent-family
url: null
as_token: "$AS_TOKEN"
hs_token: "$HS_TOKEN"
sender_localpart: af_system
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@agent_.*:af\\\\.test"
EOF
chown -R 991:991 data

pkill -f '/work/matrix/rules.py' 2>/dev/null || true
AS_TOKEN="$AS_TOKEN" nohup python3 /work/matrix/rules.py > rules.log 2>&1 &

docker rm -f afa-synapse afa-nginx >/dev/null 2>&1 || true
docker run -d --name afa-synapse --network host -v /work/matrix/data:/data -v /work/matrix/modules:/modules:ro -e PYTHONPATH=/modules "$IMG" >/dev/null
docker run -d --name afa-nginx --network host -v /work/matrix/nginx.conf:/etc/nginx/nginx.conf:ro nginx:1.27-alpine >/dev/null

for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then echo "synapse up after ${i}s"; break; fi
  sleep 1
done
curl -s -o /dev/null -w 'public entry: %{http_code}\n' http://127.0.0.1:8080/_matrix/client/versions
