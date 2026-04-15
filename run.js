/**
 * run.js
 *
 * CLI runner for the vibe-editor project.
 * Accepts a natural language prompt and optional video filename,
 * runs the full Claude generation + Remotion render pipeline,
 * and outputs a ready-to-watch .mp4 file to the output/ folder.
 *
 * Usage:
 *   node run.js                                        — interactive prompt, default video
 *   node run.js "your prompt here"                     — immediate run, default video
 *   node run.js "your prompt here" my-video.mp4        — immediate run, custom video from public/
 *
 * Note: Transcript is the hardcoded test fixture until Stage 2 brings in Whisper.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { generateVideoComponent } = require("./src/claude/generate");
const { renderVideo } = require("./src/video/render");

// Default video file — must exist in public/
const DEFAULT_VIDEO = "test-video.mp4";

// Fixed transcript path — replaced by Whisper in Stage 2
const TRANSCRIPT_PATH = path.join(__dirname, "tests", "fixtures", "sample-transcript.json");

/**
 * getPrompt
 * Returns the user prompt either from the command line argument or via
 * interactive readline input if no argument was provided.
 *
 * @returns {Promise<string>} The prompt string entered by the user.
 * @throws {Error} If the resulting prompt is empty.
 */
async function getPrompt() {
  const arg = process.argv[2];

  if (arg && arg.trim().length > 0) {
    return arg.trim();
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question("Enter your prompt: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        reject(new Error("Prompt cannot be empty."));
      } else {
        resolve(trimmed);
      }
    });
  });
}

/**
 * resolveVideo
 * Validates that the given video filename exists in the public/ folder.
 *
 * @param {string} filename - The video filename to resolve, e.g. "my-video.mp4"
 * @returns {string} The filename (not full path — render pipeline expects filename only).
 * @throws {Error} If the file does not exist in public/.
 */
function resolveVideo(filename) {
  const fullPath = path.join(__dirname, "public", filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      "Video file not found: public/" + filename + "\n" +
      "  Place your video in the public/ folder and pass just the filename."
    );
  }
  return filename;
}

/**
 * loadTranscript
 * Reads and parses the hardcoded test transcript fixture.
 * This is replaced by Whisper transcription in Stage 2.
 *
 * @returns {Array} Array of subtitle objects with text, startTime, endTime, wordTimings.
 * @throws {Error} If the fixture file cannot be read or parsed.
 */
function loadTranscript() {
  try {
    return JSON.parse(fs.readFileSync(TRANSCRIPT_PATH, "utf8"));
  } catch (error) {
    throw new Error("Failed to load transcript fixture: " + error.message);
  }
}

/**
 * generateOutputFilename
 * Creates a unique output filename using the current timestamp.
 *
 * @returns {string} A filename in the format "run-{timestamp}.mp4"
 */
function generateOutputFilename() {
  return "run-" + Date.now() + ".mp4";
}

/**
 * printSummary
 * Prints a formatted run summary block before generation starts.
 *
 * @param {string} prompt          - The user's prompt string.
 * @param {string} videoFilename   - The resolved video filename.
 * @param {string} outputFilename  - The generated output filename.
 * @returns {void}
 */
function printSummary(prompt, videoFilename, outputFilename) {
  console.log("\n═══════════════════════════════════════════");
  console.log("  VIBE EDITOR — GENERATING VIDEO");
  console.log("═══════════════════════════════════════════");
  console.log("  Prompt : \"" + prompt + "\"");
  console.log("  Video  : public/" + videoFilename);
  console.log("  Output : output/" + outputFilename);
  console.log("  Note   : Using test transcript fixture");
  console.log("═══════════════════════════════════════════\n");
}

/**
 * main
 * Orchestrates the full CLI run:
 * parse input → validate video → load transcript → generate JSX → render → report.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const startTime = Date.now();

  try {
    // Step 1: Resolve prompt (argument or interactive)
    const prompt = await getPrompt();

    // Step 2: Resolve video source (argument or default)
    const videoFilename = resolveVideo(process.argv[3] || DEFAULT_VIDEO);

    // Step 3: Load transcript fixture
    const transcript = loadTranscript();

    // Step 4: Generate unique output filename
    const outputFilename = generateOutputFilename();

    // Step 5: Print run summary
    printSummary(prompt, videoFilename, outputFilename);

    // Step 6: Generate JSX via Claude
    console.log("→ Calling Claude...");
    const jsxString = await generateVideoComponent(prompt, transcript);
    console.log("→ JSX received (" + jsxString.length + " characters)");

    // Step 7: Render via Remotion
    console.log("→ Rendering with Remotion...");
    const outputPath = await renderVideo(jsxString, outputFilename, transcript, videoFilename);

    // Step 8: Print success
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log("\n✓ Done in " + elapsed + "s");
    console.log("  " + outputPath + "\n");

  } catch (error) {
    console.error("\n✗ Error: " + error.message + "\n");
    process.exit(1);
  }
}

main();
