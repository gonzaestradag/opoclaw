import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from 'remotion';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const spr = (frame: number, fps: number, delay = 0, damping = 12, stiffness = 100) =>
  spring({ frame: frame - delay, fps, config: { damping, stiffness, mass: 0.6 } });

const ease = (f: number, from: number, to: number, a: number, b: number) =>
  interpolate(f, [a, b], [from, to], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

// ── Speed lines ─────────────────────────────────────────────────────────────
const SpeedLines: React.FC<{ frame: number; color?: string; count?: number }> = ({
  frame, color = '#ffffff', count = 16,
}) => (
  <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>
    {Array.from({ length: count }).map((_, i) => {
      const y = (i / count) * 100 + ((frame * (2 + i * 0.3)) % 100);
      const w = 40 + (i % 3) * 30;
      const opacity = ease(frame, 0, 0.12 + (i % 4) * 0.04, 0, 8);
      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: `${y % 100}%`,
            left: 0,
            width: `${w}%`,
            height: 1.5 + (i % 3) * 0.5,
            background: color,
            opacity,
            transform: `skewY(${-3 + (i % 5)}deg)`,
          }}
        />
      );
    })}
  </AbsoluteFill>
);

// ── Scene 1 — COLD OPEN: black silence then SLAM (0–70f) ───────────────────
const SceneColdOpen: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const flash = ease(frame, 0, 1, 18, 22);
  const flashOut = ease(frame, 1, 0, 22, 42);
  const flashOpacity = frame < 22 ? flash : flashOut;

  const wordScale = spr(frame, fps, 20, 8, 200);
  const wordOpacity = ease(frame, 0, 1, 18, 28);

  return (
    <AbsoluteFill style={{ background: '#000000', justifyContent: 'center', alignItems: 'center' }}>
      {/* White flash */}
      <AbsoluteFill style={{ background: '#ffffff', opacity: flashOpacity }} />

      {/* MOVE */}
      <div
        style={{
          transform: `scale(${wordScale})`,
          opacity: wordOpacity,
          fontSize: 260,
          fontWeight: 900,
          color: '#ffffff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          letterSpacing: '-0.06em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        MOVE.
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 2 — WORD SLAM (70–200f) ───────────────────────────────────────────
const BigWord: React.FC<{
  text: string;
  frame: number;
  fps: number;
  delay: number;
  color?: string;
  size?: number;
}> = ({ text, frame, fps, delay, color = '#ffffff', size = 220 }) => {
  const sc = spr(frame, fps, delay, 7, 180);
  const op = ease(frame, 0, 1, delay, delay + 10);
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: 900,
        color,
        transform: `scale(${sc})`,
        opacity: op,
        lineHeight: 0.88,
        letterSpacing: '-0.05em',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {text}
    </div>
  );
};

const SceneJustDoIt: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const lineW = ease(frame, 0, 100, 5, 35);
  const subOpacity = ease(frame, 0, 1, 85, 110);
  const subY = ease(frame, 18, 0, 85, 110);

  return (
    <AbsoluteFill
      style={{
        background: '#000000',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 110px',
      }}
    >
      <SpeedLines frame={frame} color="#ffffff" count={10} />

      <div style={{ position: 'relative', zIndex: 2 }}>
        <BigWord text="JUST" frame={frame} fps={fps} delay={0} />
        <BigWord text="DO" frame={frame} fps={fps} delay={15} color="#e5e5e5" />
        <BigWord text="IT." frame={frame} fps={fps} delay={30} color="#ffffff" />
      </div>

      {/* Red underline */}
      <div
        style={{
          marginTop: 32,
          height: 6,
          width: `${lineW}%`,
          background: '#cc0000',
          borderRadius: 3,
          zIndex: 2,
        }}
      />

      <div
        style={{
          opacity: subOpacity,
          transform: `translateY(${subY}px)`,
          marginTop: 36,
          fontSize: 24,
          color: '#555555',
          letterSpacing: '0.25em',
          textTransform: 'uppercase',
          fontWeight: 600,
          zIndex: 2,
        }}
      >
        No excuses. No limits.
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 3 — RAPID CUTS: athlete stats (200–330f) ──────────────────────────
const RapidCut: React.FC<{
  frame: number;
  fps: number;
  stat: string;
  label: string;
  accent: string;
  localFrame: number;
}> = ({ fps, stat, label, accent, localFrame }) => {
  const sc = spr(localFrame, fps, 0, 9, 160);
  const op = ease(localFrame, 0, 1, 0, 12);
  const lineW = ease(localFrame, 0, 100, 4, 30);

  return (
    <AbsoluteFill
      style={{ background: '#000000', justifyContent: 'center', padding: '0 110px', flexDirection: 'column' }}
    >
      <SpeedLines frame={localFrame * 2} color={accent} count={20} />
      <div
        style={{
          fontSize: 15,
          color: accent,
          letterSpacing: '0.35em',
          textTransform: 'uppercase',
          fontWeight: 700,
          marginBottom: 16,
          opacity: op,
          zIndex: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 240,
          fontWeight: 900,
          color: '#ffffff',
          letterSpacing: '-0.06em',
          lineHeight: 0.85,
          transform: `scale(${sc})`,
          transformOrigin: 'left center',
          opacity: op,
          fontFamily: 'system-ui, sans-serif',
          zIndex: 2,
        }}
      >
        {stat}
      </div>
      <div
        style={{
          marginTop: 28,
          width: `${lineW}%`,
          height: 4,
          background: accent,
          borderRadius: 2,
          zIndex: 2,
        }}
      />
    </AbsoluteFill>
  );
};

const SceneRapidCuts: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const cuts = [
    { stat: '100%', label: 'Commitment', accent: '#cc0000', start: 0, end: 44 },
    { stat: '0', label: 'Days off', accent: '#ffffff', start: 40, end: 84 },
    { stat: '∞', label: 'Potential', accent: '#cc0000', start: 80, end: 130 },
  ];

  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {cuts.map((cut, i) => {
        const visible = frame >= cut.start && frame < cut.end + 6;
        if (!visible) return null;
        const localFrame = frame - cut.start;
        const fadeOut = ease(frame, 1, 0, cut.end, cut.end + 6);
        return (
          <AbsoluteFill key={i} style={{ opacity: fadeOut }}>
            <RapidCut {...cut} localFrame={localFrame} fps={fps} />
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};

// ── Scene 4 — SWOOSH CLOSE (330–450f) ───────────────────────────────────────
const Swoosh: React.FC<{ progress: number }> = ({ progress }) => {
  const p = clamp(progress, 0, 1);
  // Draw a bezier-like swoosh using a div with border-radius trick
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -58%)',
        width: 600 * p,
        height: 120 * p,
        borderBottom: `14px solid #ffffff`,
        borderRight: `14px solid #ffffff`,
        borderRadius: `0 0 ${180 * p}px ${20 * p}px`,
        opacity: p > 0.05 ? 1 : 0,
        transition: 'none',
        rotate: '-18deg',
        filter: 'drop-shadow(0 0 20px #ffffff44)',
      }}
    />
  );
};

const SceneClose: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const swooshProgress = ease(frame, 0, 1, 10, 45);
  const logoOpacity = ease(frame, 0, 1, 45, 70);
  const tagScale = spr(frame, fps, 55, 16);
  const tagOpacity = ease(frame, 0, 1, 55, 80);
  const ctaOpacity = ease(frame, 0, 1, 80, 100);

  const pulse = Math.sin((frame / 6) * Math.PI) * 0.02 + 1;

  return (
    <AbsoluteFill
      style={{ background: '#000000', justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}
    >
      {/* Glow */}
      <div
        style={{
          position: 'absolute',
          width: 700,
          height: 700,
          borderRadius: '50%',
          background: 'radial-gradient(circle, #cc000015 0%, transparent 65%)',
          transform: `scale(${pulse})`,
        }}
      />

      <Swoosh progress={swooshProgress} />

      <div
        style={{
          opacity: logoOpacity,
          fontSize: 18,
          color: '#ffffff',
          letterSpacing: '0.45em',
          textTransform: 'uppercase',
          fontWeight: 700,
          marginTop: 100,
          zIndex: 2,
        }}
      >
        NIKE
      </div>

      <div
        style={{
          transform: `scale(${tagScale})`,
          opacity: tagOpacity,
          fontSize: 80,
          fontWeight: 900,
          color: '#ffffff',
          letterSpacing: '-0.03em',
          marginTop: 16,
          zIndex: 2,
        }}
      >
        Just Do It.
      </div>

      {/* Red dot */}
      <div
        style={{
          opacity: ctaOpacity,
          marginTop: 40,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: '#cc0000',
          zIndex: 2,
          boxShadow: '0 0 24px #cc000088',
        }}
      />
    </AbsoluteFill>
  );
};

// ── MASTER COMPOSITION ──────────────────────────────────────────────────────
export const NikeAd: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: '#000000' }}>
      <Sequence from={0} durationInFrames={80}>
        <SceneColdOpen frame={frame} fps={fps} />
      </Sequence>
      <Sequence from={70} durationInFrames={145}>
        <SceneJustDoIt frame={frame - 70} fps={fps} />
      </Sequence>
      <Sequence from={200} durationInFrames={138}>
        <SceneRapidCuts frame={frame - 200} fps={fps} />
      </Sequence>
      <Sequence from={325}>
        <SceneClose frame={frame - 325} fps={fps} />
      </Sequence>
    </AbsoluteFill>
  );
};
