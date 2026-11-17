export const NOTEBOOK_IMAGE_COMMANDS = [
  'RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*',
  'RUN python3 -m venv /opt/praxis-notebook && /opt/praxis-notebook/bin/pip install --no-cache-dir ipykernel==6.29.5 jupyter-client==8.6.3',
  'ENV PATH="/opt/praxis-notebook/bin:$PATH"',
  'RUN mkdir -p /var/lib/praxis/notebook',
];
