FROM node:24-slim
WORKDIR /app
# Chromium for pdfRenderService (Phase 2B: template HTML -> PDF).
# apt chromium, NOT puppeteer's own download -- one binary, managed by the
# base image's debian, resolved at /usr/bin/chromium (pdfRenderService
# falls back through PUPPETEER_EXECUTABLE_PATH and common alternates).
# fonts-liberation + dejavu: metric-compatible Arial/Times/Courier stand-ins
# so contracts don't render in chromium's last-resort fallback font.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
