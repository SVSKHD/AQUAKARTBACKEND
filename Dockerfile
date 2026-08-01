FROM node:22-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=5300
ENV NPM_CONFIG_LOGLEVEL=warn

COPY package*.json ./

# Backend does not need development lifecycle scripts such as Husky
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts; \
    else \
      npm install --omit=dev --ignore-scripts; \
    fi

RUN npm install --global pm2

COPY . .

EXPOSE 5300

CMD ["pm2-runtime", "start", "index.js", "--name", "aquakart-backend"]
