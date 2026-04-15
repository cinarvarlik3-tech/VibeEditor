/**
 * transcribe.js
 * Whisper transcription module for Vibe Editor.
 *
 * Calls the OpenAI Whisper CLI via a Python subprocess and returns a
 * word-level timestamped transcript in the format expected by Claude
 * and the Remotion render pipeline.
 *
 * Exports:
 *   transcribeAudio(audioPath, language?) → Promise<Segment[]>
 *
 * Segment shape:
 *   { text: string, startTime: number, endTime: number,
 *     wordTimings: [{ word: string, start: number, end: number }] }
 */

'use strict';

const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');

/**
 * Transcribes a WAV audio file using OpenAI Whisper (turbo model).
 * Requires Python 3 and the openai-whisper package to be installed.
 *
 * Whisper is called with --word_timestamps True so each segment
 * includes per-word timing data.  The JSON output file Whisper writes
 * is read, parsed, and then deleted.
 *
 * @param  {string}      audioPath  Absolute path to a 16 kHz mono WAV file
 * @param  {string|null} language   ISO language code (e.g. 'en', 'tr'), or null for auto-detect
 * @returns {Promise<Array>}        Array of transcript segment objects
 * @throws {Error}                  If Whisper fails, or its output cannot be parsed
 */
async function transcribeAudio(audioPath, language = null) {
  return new Promise((resolve, reject) => {
    const tempDir  = path.dirname(audioPath);
    const baseName = path.basename(audioPath, path.extname(audioPath));

    // Whisper writes {baseName}.json into the output directory
    const whisperOutputPath = path.join(tempDir, `${baseName}.json`);

    // Include Homebrew bin in PATH so Whisper can locate ffmpeg
    const env = `PATH="/opt/homebrew/bin:$PATH"`;
    let command = `${env} python3 -m whisper "${audioPath}" --model turbo --word_timestamps True --output_format json --output_dir "${tempDir}"`;

    if (language) {
      command += ` --language ${language}`;
    }

    // 10 MB stdout buffer — Whisper JSON can be large for long files
    let cleanup;
    const whisperProcess = exec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      process.removeListener('SIGTERM', cleanup);
      process.removeListener('SIGINT',  cleanup);
      process.removeListener('exit',    cleanup);

      if (err) {
        return reject(
          new Error(`transcribeAudio: Whisper process failed\n${stderr}\n${err.message}`)
        );
      }

      if (!fs.existsSync(whisperOutputPath)) {
        return reject(
          new Error(`transcribeAudio: expected output file not found — ${whisperOutputPath}`)
        );
      }

      let whisperData;
      try {
        whisperData = JSON.parse(fs.readFileSync(whisperOutputPath, 'utf8'));
      } catch (parseErr) {
        return reject(
          new Error(`transcribeAudio: could not parse Whisper JSON — ${parseErr.message}`)
        );
      }

      // Clean up the temp JSON file immediately after parsing
      try { fs.unlinkSync(whisperOutputPath); } catch (_) { /* best-effort */ }

      // Transform Whisper's segment format into Vibe Editor's transcript format
      const transcript = (whisperData.segments || []).map(segment => ({
        text: segment.text.trim(),
        startTime: segment.start,
        endTime: segment.end,
        wordTimings: (segment.words || []).map(w => ({
          word:  w.word.trim(),
          start: w.start,
          end:   w.end,
        })),
      }));

      resolve(transcript);
    });

    // Kill the Whisper subprocess if the Node process is terminated mid-transcription
    cleanup = () => {
      try { whisperProcess.kill('SIGTERM'); } catch (_) { /* already exited */ }
    };
    process.once('SIGTERM', cleanup);
    process.once('SIGINT',  cleanup);
    process.once('exit',    cleanup);
  });
}

module.exports = { transcribeAudio };
