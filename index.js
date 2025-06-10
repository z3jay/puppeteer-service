const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const os = require('os');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

// --- Setup Multer for file uploads ---
// This will save uploaded files to a temporary directory
const upload = multer({ dest: os.tmpdir() });

const app = express();
app.use(express.json({ limit: '10mb' }));

async function launchBrowser() {
  return puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

// --- NEW /convert/raw-to-mp3 Endpoint ---
// This endpoint accepts a raw audio file and converts it to MP3
app.post('/convert/raw-to-mp3', upload.single('audio'), async (req, res, next) => {
  // 1. Validate inputs
  const audioFile = req.file;
  if (!audioFile) {
    return res.status(400).send('Missing `audio` file upload.');
  }

  // Get conversion parameters from the request body
  const { 
    sampleRate = '24000', 
    channels = '1', 
    quality = '2',
    inputCodec = 's16le' // Default to signed 16-bit little-endian PCM
  } = req.body;

  try {
    // 2. Set response header for MP3 audio
    res.setHeader('Content-Type', 'audio/mpeg');

    // 3. Use FFmpeg to convert the raw audio to MP3 and stream it
    ffmpeg(audioFile.path)
      .inputOptions([
        `-f ${inputCodec}`, // Explicitly set the input format codec
        `-ar ${sampleRate}`, // Set input sample rate
        `-ac ${channels}` // Set input audio channels
      ])
      .audioCodec('libmp3lame') // Output codec
      .audioQuality(quality) // Output quality (0-9, lower is better)
      .toFormat('mp3')
      .on('error', (err) => {
        console.error('An error occurred during FFmpeg processing:', err.message);
        next(err);
      })
      .pipe(res, { end: true }); // Stream the output directly to the response

  } catch (error) {
    console.error('An unexpected error occurred:', error.message);
    next(error);
  } finally {
    // 4. Clean up the temporary uploaded file after the response is sent
    res.on('finish', async () => {
      try {
        await fs.unlink(audioFile.path);
      } catch (e) {
        console.error("Error cleaning up temp file:", e.message);
      }
    });
  }
});

// --- NEW /convert/gemini-audio-to-mp3 Endpoint ---
// This endpoint accepts a Gemini API JSON response and converts the contained audio to MP3.
app.post('/convert/gemini-audio-to-mp3', async (req, res, next) => {
  let tempFilePath;

  try {
    // 1. Validate and extract data from the Gemini response
    const geminiResponse = req.body;
    if (!geminiResponse || !Array.isArray(geminiResponse) || geminiResponse.length === 0) {
      return res.status(400).send('Invalid Gemini response format: Expected a JSON array.');
    }

    const inlineData = geminiResponse[0]?.candidates[0]?.content?.parts[0]?.inlineData;
    if (!inlineData || !inlineData.data || !inlineData.mimeType) {
        return res.status(400).send('Missing audio data in Gemini response. Expected inlineData with data and mimeType.');
    }

    const { mimeType, data: base64Audio } = inlineData;

    // 2. Parse mimeType to get audio parameters
    const rateMatch = mimeType.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? rateMatch[1] : '24000'; // Default to 24000Hz if not specified

    // Gemini's audio/L16 is signed 16-bit little-endian PCM.
    const inputCodec = 's16le'; 
    const channels = '1'; // Gemini TTS is typically mono
    const quality = '2'; // A good default for quality

    // 3. Decode base64 audio and write to a temporary file
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    tempFilePath = path.join(os.tmpdir(), `gemini-audio-${Date.now()}.raw`);
    await fs.writeFile(tempFilePath, audioBuffer);
    
    // 4. Set response header for MP3 audio
    res.setHeader('Content-Type', 'audio/mpeg');

    // 5. Use FFmpeg to convert the raw audio to MP3 and stream it to the response
    ffmpeg(tempFilePath)
      .inputOptions([
        `-f ${inputCodec}`,
        `-ar ${sampleRate}`,
        `-ac ${channels}`
      ])
      .audioCodec('libmp3lame')
      .audioQuality(quality)
      .toFormat('mp3')
      .on('error', (err) => {
        console.error('An error occurred during FFmpeg processing:', err.message);
        next(err);
      })
      .pipe(res, { end: true });

  } catch (error) {
    console.error('An unexpected error occurred:', error.message);
    next(error);
  } finally {
    // 6. Clean up the temporary file after the response is sent
    res.on('finish', async () => {
        if (tempFilePath) {
            try {
                await fs.unlink(tempFilePath);
            } catch (e) {
                console.error("Error cleaning up temp file:", e.message);
            }
        }
    });
  }
});

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
