/**
 * src/video/render.js
 *
 * Remotion render pipeline for the vibe-editor project.
 * Takes a JSX string produced by Claude and renders it to an .mp4 file.
 *
 * Role in project:
 *   This is the final step in the Stage 1 core loop.
 *   It writes the generated JSX to disk, then invokes Remotion's CLI
 *   render command via Node's child_process, and returns the output path.
 *
 * Process:
 *   1. Write jsxString → src/compositions/GeneratedVideo.jsx (overwrites every time)
 *   2. Execute: npx remotion render src/index.js GeneratedVideo output/{outputFilename}
 *   3. Return full output file path on success, or throw with full Remotion error on failure.
 */

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// Absolute path to the generated composition file.
// This is overwritten on every render call.
const GENERATED_VIDEO_PATH = path.join(
  __dirname,
  "..",
  "compositions",
  "GeneratedVideo.jsx"
);

// Absolute path to the output directory
const OUTPUT_DIR = path.join(__dirname, "..", "..", "output");

// Temporary props file written before each render and deleted after.
// Using a file instead of inline --props to safely handle apostrophes in transcript text.
const PROPS_FILE = path.join(OUTPUT_DIR, ".render-props.json");

/**
 * writeJsxFile
 * Writes the Claude-generated JSX string to GeneratedVideo.jsx on disk.
 * This file is pre-registered in src/index.js and Remotion re-bundles it on every render.
 *
 * @param {string} jsxString - Raw JSX string from generateVideoComponent().
 * @returns {void}
 * @throws {Error} If the file write fails.
 */
function writeJsxFile(jsxString) {
  try {
    fs.writeFileSync(GENERATED_VIDEO_PATH, jsxString, "utf8");
  } catch (error) {
    throw new Error("renderVideo: Failed to write GeneratedVideo.jsx — " + error.message);
  }
}

/**
 * ensureOutputDir
 * Creates the output directory if it does not exist.
 *
 * @returns {void}
 */
function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * writePropsFile
 * Serializes the subtitles array and optional videoSrc to a temporary JSON file.
 * Remotion's --props flag accepts a file path, which safely handles
 * any special characters (apostrophes, quotes) in subtitle text.
 *
 * @param {Array}       subtitles - Array of subtitle objects from the transcript.
 * @param {string|null} videoSrc  - Filename of the source video in public/, or null.
 * @returns {void}
 * @throws {Error} If the file write fails.
 */
function writePropsFile(subtitles, videoSrc) {
  try {
    fs.writeFileSync(PROPS_FILE, JSON.stringify({ subtitles, videoSrc }), "utf8");
  } catch (error) {
    throw new Error("renderVideo: Failed to write props file — " + error.message);
  }
}

/**
 * cleanupPropsFile
 * Deletes the temporary props file after render completes.
 * Called in a finally block so it runs on both success and failure.
 *
 * @returns {void}
 */
function cleanupPropsFile() {
  try {
    if (fs.existsSync(PROPS_FILE)) {
      fs.unlinkSync(PROPS_FILE);
    }
  } catch (_) {
    // Non-fatal — temp file cleanup failure should not surface to the caller
  }
}

/**
 * runRemotionRender
 * Executes the Remotion CLI render command via child_process.exec.
 * Remotion re-bundles src/index.js on every call, which picks up the
 * latest GeneratedVideo.jsx written by writeJsxFile().
 *
 * @param {string} outputFilename - The filename for the rendered video, e.g. "test-stage1-1.mp4"
 * @returns {Promise<string>}     - Resolves with the full output file path on success.
 * @throws {Error}                - Rejects with a descriptive error including Remotion's stderr output.
 */
function runRemotionRender(outputFilename) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(OUTPUT_DIR, outputFilename);

    // Pass subtitle data via a props file. Style defaults are already embedded
    // in the generated component by Claude — only subtitles need to be injected.
    const command =
      "npx remotion render src/index.js GeneratedVideo output/" +
      outputFilename +
      " --props=output/.render-props.json";

    // Execute from the project root directory so all relative paths resolve correctly
    const projectRoot = path.join(__dirname, "..", "..");

    exec(command, { cwd: projectRoot, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        // Include full Remotion stderr in the error message for easier debugging
        const remotionError =
          stderr || stdout || error.message || "Unknown Remotion error";
        reject(
          new Error(
            "renderVideo: Remotion render failed for " +
            outputFilename +
            "\n\n--- REMOTION OUTPUT ---\n" +
            remotionError
          )
        );
        return;
      }

      // Confirm the output file was actually created
      if (!fs.existsSync(outputPath)) {
        reject(
          new Error(
            "renderVideo: Remotion reported success but output file not found at " +
            outputPath
          )
        );
        return;
      }

      resolve(outputPath);
    });
  });
}

/**
 * renderVideo
 * Main export. Orchestrates the full render pipeline:
 * write JSX → write props → trigger Remotion → cleanup → return output path.
 *
 * @param {string}      jsxString      - Raw JSX string from generateVideoComponent().
 *                                      Must be valid Remotion JSX starting with 'import'.
 * @param {string}      outputFilename - Filename for the rendered video, e.g. "my-video.mp4"
 * @param {Array}       subtitles      - Array of subtitle objects to inject as Remotion props.
 *                                      Shape: [{ text, startTime, endTime, wordTimings }]
 * @param {string|null} videoSrc       - Filename of the source video in public/, e.g. "test-video.mp4".
 *                                      Pass null for subtitle-only renders with no video layer.
 *
 * @returns {Promise<string>}     - Resolves with the absolute path to the rendered .mp4 file.
 * @throws {Error}                - Throws if writing files or the Remotion render fails.
 */
async function renderVideo(jsxString, outputFilename, subtitles = [], videoSrc = null) {
  if (!jsxString || typeof jsxString !== "string") {
    throw new Error("renderVideo: jsxString must be a non-empty string");
  }
  if (!outputFilename || typeof outputFilename !== "string") {
    throw new Error("renderVideo: outputFilename must be a non-empty string");
  }

  // Step 1: Ensure the output directory exists
  ensureOutputDir();

  // Step 2: Write the Claude-generated JSX to disk
  writeJsxFile(jsxString);

  // Step 3: Write subtitle data and videoSrc to the temporary props file
  writePropsFile(subtitles, videoSrc);

  // Step 4: Trigger Remotion render, then clean up the temp props file
  try {
    const outputPath = await runRemotionRender(outputFilename);
    return outputPath;
  } finally {
    cleanupPropsFile();
  }
}

module.exports = { renderVideo };
