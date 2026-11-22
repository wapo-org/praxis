#!/bin/sh
# Deploy this folder to the reviewer host: back up, copy, rebuild the image when the Containerfile changed, restart, check health.
# usage: infra/pr-review/scripts/deploy.sh <ssh-target> [ssh-key]   e.g. ubuntu@127.0.0.1 ~/.ssh/praxis-host.key
set -eu

TARGET=${1:?usage: deploy.sh <ssh-target> [ssh-key]}
KEY=${2:-}
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
IMAGE_TAG=$(sed -n "s/^IMAGE = 'localhost\/praxis-review-sandbox:\(.*\)'$/\1/p" "$SOURCE/container_runtime.py")
[ -n "$IMAGE_TAG" ] || { echo "IMAGE tag not found in container_runtime.py" >&2; exit 1; }

ssh_run() {
  if [ -n "$KEY" ]; then ssh -i "$KEY" -o BatchMode=yes "$TARGET" "$@"; else ssh -o BatchMode=yes "$TARGET" "$@"; fi
}

tar -C "$SOURCE" --exclude=.venv --exclude=__pycache__ --exclude=.pytest_cache -cf - . | ssh_run "
set -eu
APP=/opt/praxis-review
INCOMING=\$(mktemp -d)
tar -C \"\$INCOMING\" -xf -
sudo cp -a \"\$APP\" \"\$APP.pre-deploy-$STAMP\"
REBUILD=no
sudo cmp -s \"\$INCOMING/Containerfile\" \"\$APP/Containerfile\" || REBUILD=yes
sudo rsync -a --delete --exclude=.venv --chown=root:root --chmod=D755,F644 \"\$INCOMING/\" \"\$APP/\"
rm -rf \"\$INCOMING\"
cd /tmp
RUNTIME=/run/user/\$(id -u praxis-review)
if [ \"\$REBUILD\" = yes ] || ! sudo -u praxis-review XDG_RUNTIME_DIR=\$RUNTIME podman image exists localhost/praxis-review-sandbox:$IMAGE_TAG; then
  BUILD=/var/lib/praxis-review/image-build
  sudo install -d -o praxis-review -g praxis-review -m 700 \$BUILD
  sudo install -o praxis-review -g praxis-review -m 600 \"\$APP/Containerfile\" \$BUILD/Containerfile
  sudo -u praxis-review XDG_RUNTIME_DIR=\$RUNTIME podman build --cgroup-manager=cgroupfs -t localhost/praxis-review-sandbox:$IMAGE_TAG \$BUILD
fi
cd \"\$APP\" && sudo -u praxis-review env HOME=/var/lib/praxis-review .venv/bin/python -c 'import ubuntu_service'
sudo systemctl restart praxis-review
sleep 3
curl -fsS http://127.0.0.1:8788/health
echo
echo \"deployed; previous version at \$APP.pre-deploy-$STAMP\"
"
