FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates fonts-dejavu-core \
 && pip3 install --break-system-packages -U yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node","server.js"]
