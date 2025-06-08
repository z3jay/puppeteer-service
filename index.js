const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const os = require('os');
const upload = multer({ dest: os.tmpdir() });

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
    width = 1080,
    height = 1080,
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
    width = 1080,
    height = 1920,
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
// --- NEW /composite Endpoint ---

app.post('/composite', upload.single('video'), async (req, res, next) => {

  // 1. Validate inputs

  const { html, overlayX = '0', overlayY = '0' } = req.body;

  const videoFile = req.file;



  if (!html) {

    return res.status(400).send('Missing `html` form field.');

  }

  if (!videoFile) {

    return res.status(400).send('Missing `video` file upload.');

  }



  const overlayImagePath = path.join(os.tmpdir(), `overlay-${Date.now()}.png`);



  try {

    // 2. Generate Screenshot of the HTML overlay

    const browser = await launchBrowser();

    const page = await browser.newPage();

    // Use a large viewport to ensure all HTML is rendered

    await page.setViewport({ width: 1920, height: 1920 });

    await page.setContent(html, { waitUntil: 'networkidle0' });

    await page.screenshot({

      path: overlayImagePath,

      omitBackground: true, // Make background transparent

      fullPage: true,

    });

    await browser.close();



    // 3. Use FFmpeg to overlay the image on the video

    res.setHeader('Content-Type', 'video/mp4');



    ffmpeg(videoFile.path) // Input 1: The uploaded video

      .input(overlayImagePath) // Input 2: The generated overlay image

      .complexFilter(`[0:v][1:v]overlay=x=${overlayX}:y=${overlayY}`) // The overlay filter

      .audioCodec('copy') // Keep original audio

      .videoCodec('libx264')

      .outputOptions('-pix_fmt yuv420p')

      .toFormat('mp4')

      .on('error', (err) => next(err)) // Error handling

      .pipe(res, { end: true }); // Stream the output directly to the response



  } catch (error) {

    next(error); // Pass errors to an error handler

  } finally {

    // 4. Clean up the temporary files after streaming is done

    res.on('finish', async () => {

        try {

            await fs.unlink(videoFile.path);

            await fs.unlink(overlayImagePath);

        } catch (e) {

            console.error("Error cleaning up temp files:", e);

        }

    });

  }

});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Service listening on port ${PORT}`));
