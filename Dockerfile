FROM node:18-slim

USER root
# Install Chrome & ffmpeg
RUN apt-get update && apt-get install -y \
      wget ca-certificates fonts-liberation libappindicator3-1 \
      libasound2 libatk1.0-0 libcairo2 libdbus-1-3 libgtk-3-0 \
      libnspr4 libnss3 lsb-release xdg-utils ffmpeg \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
