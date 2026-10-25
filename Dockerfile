FROM node:22-alpine

# ffmpeg: conversione HLS e unione video+audio di yt-dlp.
# python3 + yt-dlp: video da link (YouTube e gli altri siti supportati). Questa copia fa da
# base: NoStream scarica le versioni più nuove in /app/data/bin (YouTube cambia spesso).
RUN apk add --no-cache ffmpeg python3 \
 && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4321

CMD ["node", "server.js"]
