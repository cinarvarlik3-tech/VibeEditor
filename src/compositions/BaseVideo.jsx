import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * Reference composition for Remotion wiring checks.
 * Overwritten is not expected; keep minimal and dependency-free.
 */
const BaseVideo = ({
  subtitles = [],
  primaryColor = "#FFFF00",
  secondaryColor = "#FFFFFF",
  fontSize = 48,
  backgroundColor = "#000000",
  fontFamily = "Arial",
}) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();

  const opacity = interpolate(frame, [0, 1.5 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {subtitles.map((line, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: height * 0.12,
            color: i === 0 ? primaryColor : secondaryColor,
            fontSize,
            fontFamily,
            textAlign: "center",
            opacity,
            width,
          }}
        >
          {line}
        </div>
      ))}
    </AbsoluteFill>
  );
};

export default BaseVideo;
