import {readFileSync} from 'node:fs';

const REQUIREMENTS_PATH = '/opt/praxis-notebook/requirements.lock';
const REQUIREMENTS_BASE64 = readFileSync(new URL('./notebook-requirements.lock', import.meta.url)).toString('base64');

export const NOTEBOOK_IMAGE_COMMANDS = [
  'RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*',
  `RUN python3 -m venv /opt/praxis-notebook && printf '%s' '${REQUIREMENTS_BASE64}' | base64 -d > ${REQUIREMENTS_PATH}`,
  `RUN /opt/praxis-notebook/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r ${REQUIREMENTS_PATH} && /opt/praxis-notebook/bin/pip check`,
  'ENV PATH="/opt/praxis-notebook/bin:$PATH"',
  'RUN mkdir -p /var/lib/praxis/notebook',
];
