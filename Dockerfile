FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Install Playwright browsers
RUN npx playwright install chromium

# Create data and reports dirs
RUN mkdir -p data reports

EXPOSE 3100

CMD ["npx", "tsx", "scripts/slack-bot.ts"]
