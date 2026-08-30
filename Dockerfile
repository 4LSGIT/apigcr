# Base image carries node + chromium + fonts; see Dockerfile.base for why the
# chromium apt layer is NOT in this file (it was re-pushing ~800 MB per deploy)
# and why it lives in a separate Artifact Registry repo.
# Rebuild the base and bump this tag when node or chromium needs patching.
FROM us-east1-docker.pkg.dev/lsg-api-425223/svpcac-base/base:1
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
