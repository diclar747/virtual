FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4173
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node server.mjs db.mjs ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
COPY --chown=node:node knowledge ./knowledge
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
