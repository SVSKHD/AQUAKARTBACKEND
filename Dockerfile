FROM node:22-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=5300
ENV NPM_CONFIG_LOGLEVEL=warn

# Copy dependency files first for Docker caching
COPY package*.json ./

# Use npm ci when package-lock exists; otherwise use npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Install PM2 runtime
RUN npm install --global pm2

# Copy application source
COPY . .

EXPOSE 5300

CMD ["pm2-runtime", "start", "index.js", "--name", "aquakart-backend"]
