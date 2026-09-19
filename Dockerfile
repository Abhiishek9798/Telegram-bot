FROM node:22-bookworm-slim

# Install ffmpeg and curl
RUN apt-get update && \
    apt-get install -y ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN mkdir -p downloads

CMD ["node", "bot.js"]