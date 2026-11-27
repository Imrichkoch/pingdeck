FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund && npm cache clean --force \
    && install -d -m 0700 -o node -g node /data
COPY *.mjs branding.json ./
COPY public ./public
COPY views ./views
USER node
EXPOSE 3417
CMD ["node", "server.mjs"]
