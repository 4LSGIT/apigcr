# Base image carries node + chromium + fonts; see Dockerfile.base for why the
# chromium apt layer is NOT in this file (it was re-pushing ~800 MB per deploy)
# and why it lives in a separate Artifact Registry repo.
# Rebuild the base and bump this tag when node or chromium needs patching.
FROM us-east1-docker.pkg.dev/lsg-api-425223/svpcac-base/base:1
WORKDIR /app
# Registry stalls from the Cloud Build pool produced 5-min silent installs
# (2026-09-04 investigation). Retry harder and give up sooner per request.
ENV npm_config_fetch_retries=5
ENV npm_config_fetch_timeout=120000
COPY package*.json ./
# npm ci, not npm install: lockfile is committed as of 2026-09. Deterministic
# tree, skips resolution, and makes the docker layer cache key honest.
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
