/**
 * extract.js
 * Audio and frame extraction module for Vibe Editor.
 *
 * Uses fluent-ffmpeg with the system ffmpeg at /opt/homebrew/bin/ffmpeg.
 *
 * Exports:
 *   extractAudio(videoPath)           → Promise<string>   path to .wav file
 *   extractFrames(videoPath, count)   → Promise<string[]> paths to frame JPGs
 */

'use strict';

const ffmpeg = require('fluent-ffmpeg');
const path   = require('path');
const fs     = require('fs');

// Use Homebrew ffmpeg explicitly so it is found regardless of shell PATH
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
ffmpeg.setFfmpegPath(FFMPEG_PATH);

/**
 * Extracts audio from a video file as a mono 16 kHz WAV.
 * Whisper requires 16 kHz mono audio; any other sample rate will fail silently.
 *
 * @param  {string} videoPath  Absolute path to the source video file
 * @returns {Promise<string>}  Absolute path to the extracted .wav file
 * @throws {Error}             If the video has no audio track or extraction fails
 */
async function extractAudio(videoPath) {
  return new Promise((resolve, reject) => {
    const baseName  = path.basename(videoPath, path.extname(videoPath));
    const outputPath = path.join(path.dirname(videoPath), `${baseName}-audio.wav`);

    // First probe to confirm an audio stream exists
    ffmpeg.ffprobe(videoPath, (probeErr, metadata) => {
      if (probeErr) {
        return reject(new Error(`extractAudio: ffprobe failed — ${probeErr.message}`));
      }

      const hasAudio = (metadata.streams || []).some(s => s.codec_type === 'audio');
      if (!hasAudio) {
        return reject(new Error(`extractAudio: video has no audio track — ${videoPath}`));
      }

      ffmpeg(videoPath)
        .noVideo()
        .audioChannels(1)       // mono  — required by Whisper
        .audioFrequency(16000)  // 16 kHz — required by Whisper
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', err => reject(new Error(`extractAudio: ffmpeg failed — ${err.message}`)))
        .run();
    });
  });
}

/**
 * Extracts evenly-spaced frames from a video as JPEG images.
 * Frames are saved to the project-root /frames directory.
 *
 * @param  {string} videoPath  Absolute path to the source video file
 * @param  {number} count      Number of frames to extract (default: 5)
 * @returns {Promise<string[]>} Array of absolute paths to the extracted JPEGs
 * @throws {Error}             If ffmpeg fails or the video cannot be probed
 */
async function extractFrames(videoPath, count = 5) {
  return new Promise((resolve, reject) => {
    const baseName  = path.basename(videoPath, path.extname(videoPath));
    const framesDir = path.join(process.cwd(), 'frames');

    // Ensure output directory exists
    fs.mkdirSync(framesDir, { recursive: true });

    // Probe to get duration so we can calculate the interval
    ffmpeg.ffprobe(videoPath, (probeErr, metadata) => {
      if (probeErr) {
        return reject(new Error(`extractFrames: ffprobe failed — ${probeErr.message}`));
      }

      const duration = metadata.format.duration || 0;
      if (duration === 0) {
        return reject(new Error(`extractFrames: could not determine video duration`));
      }

      // screenshots() is the most reliable fluent-ffmpeg API for this purpose
      ffmpeg(videoPath)
        .screenshots({
          count,
          folder: framesDir,
          filename: `${baseName}-frame-%i.jpg`,
        })
        .on('end', () => {
          // Collect only paths that actually exist (count may be capped by duration)
          const framePaths = Array.from({ length: count }, (_, i) =>
            path.join(framesDir, `${baseName}-frame-${i + 1}.jpg`)
          ).filter(p => fs.existsSync(p));

          resolve(framePaths);
        })
        .on('error', err =>
          reject(new Error(`extractFrames: ffmpeg failed — ${err.message}`))
        );
    });
  });
}

/**
 * convertImageToVideo
 * Converts a static image (jpg/png/gif/webp) to a looping mp4 video clip.
 * Output path = inputBasename + '.mp4' (multer already timestamps the filename,
 * so e.g. "1234567890-logo.png" → "1234567890-logo.mp4").
 *
 * @param  {string} imagePath   Absolute path to the source image file
 * @param  {number} duration    Output video duration in seconds (default: 10)
 * @returns {Promise<{ outputPath: string, duration: number, width: number, height: number }>}
 * @throws {Error} If ffmpeg fails or the image cannot be probed
 */
async function convertImageToVideo(imagePath, duration = 10) {
  return new Promise((resolve, reject) => {
    const inputBasename = path.basename(imagePath, path.extname(imagePath));
    const outputPath    = path.join(path.dirname(imagePath), inputBasename + '.mp4');

    // Probe image dimensions first
    ffmpeg.ffprobe(imagePath, (probeErr, metadata) => {
      if (probeErr) {
        return reject(new Error(`convertImageToVideo: ffprobe failed — ${probeErr.message}`));
      }

      const videoStream = (metadata.streams || []).find(s => s.codec_type === 'video');
      const width  = videoStream ? videoStream.width  : 0;
      const height = videoStream ? videoStream.height : 0;

      ffmpeg(imagePath)
        .inputOptions(['-loop 1'])
        .videoCodec('libx264')
        .outputOptions([
          `-t ${duration}`,
          '-pix_fmt yuv420p',
          // Ensure dimensions are divisible by 2 (H.264 requirement)
          '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
        ])
        .output(outputPath)
        .on('end', () => resolve({ outputPath, duration, width, height }))
        .on('error', err =>
          reject(new Error(`convertImageToVideo: ffmpeg failed — ${err.message}`))
        )
        .run();
    });
  });
}

module.exports = { extractAudio, extractFrames, convertImageToVideo };
