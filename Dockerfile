# Node's own SQLite driver (node:sqlite) needs 22.5 or newer, and pdf-lib wants a
# recent V8, so the base is pinned to the current LTS line rather than :latest.
FROM node:24-bookworm-slim

# Every dependency is pure JavaScript — bcryptjs, not the native bcrypt — so no
# build toolchain is needed in the image, and nothing runs a postinstall script.
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

# /data is the mounted volume: the SQLite database and the customer files
# (booking PDFs, avatars) live there, so they survive a redeploy. The process
# creates the folders itself on first write; all this needs to do is own them.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_FILE=/data/naina.db \
    UPLOADS_DIR=/data/uploads

EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
