/**
 * src/index.js
 *
 * Remotion entry point for the vibe-editor project.
 * Registers all compositions with Remotion's registerRoot.
 *
 * Compositions registered here:
 *   - BaseVideo: Hand-written reference composition for validation.
 *   - GeneratedVideo: Claude-generated composition. This file is overwritten
 *     on every render call, and Remotion re-bundles it automatically.
 */

import { Composition, registerRoot } from "remotion";
import BaseVideo from "./compositions/BaseVideo.jsx";
import GeneratedVideo from "./compositions/GeneratedVideo.jsx";

/**
 * RemotionRoot
 * Registers all video compositions with their default props and dimensions.
 * 1080x1920 = vertical/portrait format (TikTok, Reels, Shorts).
 * 30fps, 150 frames = 5 seconds default duration.
 *
 * @returns {JSX.Element} Remotion composition registrations.
 */
const RemotionRoot = () => {
  return (
    <>
      {/* Base composition — used for validation and testing */}
      <Composition
        id="BaseVideo"
        component={BaseVideo}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          subtitles: [],
          primaryColor: "#FFFF00",
          secondaryColor: "#FFFFFF",
          fontSize: 48,
          backgroundColor: "#000000",
          fontFamily: "Arial",
        }}
      />

      {/* GeneratedVideo — duration from export props (calculateMetadata) */}
      <Composition
        id="GeneratedVideo"
        component={GeneratedVideo}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames ?? 450,
          fps: 30,
          width: 1080,
          height: 1920,
        })}
        defaultProps={{
          durationInFrames: 450,
          subtitles: [],
          videoSrc: null,
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
