FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY public ./public
COPY server ./server
EXPOSE 3100
CMD ["node", "server/server.js"]
