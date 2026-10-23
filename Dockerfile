FROM node:24.22.1-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3080 HOST=0.0.0.0 DATA_DIR=/app/data TZ=Asia/Shanghai
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3080
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=6 CMD node -e "fetch('http://127.0.0.1:3080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "server.mjs"]
