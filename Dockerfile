# Use Node.js base image
FROM node:18-slim

# Install Python, yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy all bot files
COPY . .

# Create downloads folder
RUN mkdir -p downloads

# Start the bot
CMD ["node", "bot.js"]