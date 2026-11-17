import type {Image, ModalClient} from 'modal';

export const NODE_VERSION = '22.16.0';
export const NODE_IMAGE_DIGEST = 'sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34';
export const BASE_IMAGE = `node:${NODE_VERSION}-bookworm-slim@${NODE_IMAGE_DIGEST}`;
export const DEBIAN_SNAPSHOT = '20250601T000000Z';
export const PYTHON_VERSION = '3.11.2';
export const DEBIAN_PACKAGES = {
  python3: '3.11.2-1+b1',
  git: '1:2.39.5-0+deb12u2',
  'build-essential': '12.9',
  tmux: '3.3a-3',
  'ca-certificates': '20230311',
} as const;
export const IMAGE_BUILD_COMMAND_TIMEOUT_SECONDS = 150;
const APT_NETWORK_TIMEOUT_SECONDS = 30;
// Apt verifies Debian signatures; HTTP bootstraps the slim base before CA certificates are installed.
const SNAPSHOT_URL = `http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/`;
const PACKAGE_SPECS = Object.entries(DEBIAN_PACKAGES).map(([name, version]) => `${name}=${version}`).join(' ');
const TOOLS_COMMANDS = [
  'rm -f /etc/apt/sources.list.d/*',
  `printf 'deb [check-valid-until=no] ${SNAPSHOT_URL} bookworm main\\n' > /etc/apt/sources.list`,
  `apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=0 -o Acquire::http::Timeout=${APT_NETWORK_TIMEOUT_SECONDS} update`,
  `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGE_SPECS}`,
  'rm -rf /var/lib/apt/lists/*',
  'mkdir -p /workspace/chats',
  `test "$(node --version)" = "v${NODE_VERSION}"`,
  `test "$(python3 --version)" = "Python ${PYTHON_VERSION}"`,
].join(' && ');

export function sandboxBaseImage(modal: ModalClient): Image {
  return modal.images.fromRegistry(BASE_IMAGE);
}

// Frozen package indexes also pin the transitive apt dependencies.
export function sandboxToolsImage(modal: ModalClient): Image {
  return sandboxBaseImage(modal).dockerfileCommands([
    `RUN timeout ${IMAGE_BUILD_COMMAND_TIMEOUT_SECONDS}s sh -ec '${TOOLS_COMMANDS.replaceAll("'", "'\\''")}'`,
    'WORKDIR /workspace',
  ]);
}
