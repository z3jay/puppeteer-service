const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

async function launchBrowser() {
  return puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--disable-dev-shm-usage`
    ]
  });
}

// --- Screenshot endpoint ---
app.post('/screenshot', async (req, res) => {
  const {
    html,
    width = 800,
    height = 600,
    omitBackground = false
  } = req.body;

  if (!html) {
    return res.status(400).send('Missing `html` in request body.');
  }

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const buffer = await page.screenshot({
    type: 'png',
    fullPage: true,
    omitBackground: Boolean(omitBackground)
  });

  await browser.close();
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

// --- Video endpoint ---
app.post('/video', async (req, res, next) => {
  const {
    html,
    width = 800,
    height = 600,
    fps = 25,
    duration = 5,
    omitBackground = false
  } = req.body;

  if (!html) {
    return res.status(400).send('Missing `html` in request body.');
  }

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Stream frames into ffmpeg
  const passThrough = new stream.PassThrough();
  const command = ffmpeg()
    .input(passThrough)
    .inputFormat('image2pipe')
    .inputOptions([`-framerate ${fps}`])
    .videoCodec('libx264')
    .outputOptions(['-pix_fmt yuv420p'])
    .format('mp4')
    .on('error', err => next(err))
    .pipe(res, { end: true });

  res.setHeader('Content-Type', 'video/mp4');

  // Capture frames
  const totalFrames = fps * duration;
  for (let i = 0; i < totalFrames; i++) {
    const buffer = await page.screenshot({
      type: 'png',
      omitBackground: Boolean(omitBackground)
    });
    passThrough.write(buffer);
    await new Promise(f => setTimeout(f, 1000 / fps));
  }

  passThrough.end();
  await browser.close();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Service listening on port ${PORT}`));
