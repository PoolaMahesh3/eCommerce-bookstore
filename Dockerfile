# Red Hat UBI minimal base (security policy: registry.redhat.io, minimal image).
# Pin a digest in CI after scanning and verifying the image signature.
FROM registry.redhat.io/ubi9/nodejs-24-minimal:latest

USER 0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
# Data directory is the only writable path (mount a volume here); everything else is read-only.
RUN mkdir -p /data && chown -R 1001:0 /data /app && chmod -R g=u /data

# Non-root runtime user.
USER 1001
ENV NODE_ENV=production DB_PATH=/data/bookstore.db PORT=8080
# Bind to the pod IP, never to a wildcard address (set HOST at deploy time, e.g. from status.podIP).
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://'+process.env.HOST+':8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
