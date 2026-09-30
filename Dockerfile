FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --ignore-scripts
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node", "src/server.js"]
