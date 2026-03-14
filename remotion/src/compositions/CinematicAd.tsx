import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from 'remotion';

// ── Helpers ────────────────────────────────────────────────────────────────
const ease = (f: number, from: number, to: number, inF: number, outF: number) =>
  interpolate(f, [inF, outF], [from, to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const spr = (frame: number, fps: number, delay = 0, damping = 14) =>
  spring({ frame: frame - delay, fps, config: { damping, stiffness: 80, mass: 0.8 } });

// ── Noise / glitch lines overlay ───────────────────────────────────────────
const GlitchLines: React.FC<{ frame: number }> = ({ frame }) => {
  const lines = [0.18, 0.34, 0.51, 0.67, 0.82];
  return (
    <>
      {lines.map((y, i) => {
        const opacity = interpolate(
          (frame + i * 17) % 60,
          [0, 2, 3, 60],
          [0, 0.4, 0, 0],
          { extrapolateRight: 'clamp' }
        );
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: `${y * 100}%`,
              left: 0,
              right: 0,
              height: 1,
              background: '#ffffff',
              opacity,
            }}
          />
        );
      })}
    </>
  );
};

// ── Diagonal stripe accent ──────────────────────────────────────────────────
const StripeAccent: React.FC<{ progress: number; color: string }> = ({ progress, color }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: `${progress * 100}%`,
      height: '100%',
      background: `linear-gradient(135deg, ${color}22 0%, ${color}08 100%)`,
      borderRight: progress > 0.99 ? 'none' : `2px solid ${color}44`,
      transition: 'none',
    }}
  />
);

// ── Scene 1 — IMPACT OPENER (0–90f) ────────────────────────────────────────
const SceneOpener: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const wordScale = spr(frame, fps, 0, 10);
  const wordScale2 = spr(frame, fps, 12, 10);
  const wordScale3 = spr(frame, fps, 24, 10);
  const lineW = ease(frame, 0, 1, 8, 55);
  const subOpacity = ease(frame, 0, 1, 45, 70);

  return (
    <AbsoluteFill style={{ background: '#060a12', justifyContent: 'center', padding: '0 120px' }}>
      <GlitchLines frame={frame} />
      <StripeAccent progress={lineW} color="#0d9488" />

      <div style={{ position: 'relative', zIndex: 2 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            { text: 'NO', scale: wordScale, color: '#ffffff' },
            { text: 'MAS', scale: wordScale2, color: '#0d9488' },
            { text: 'LÍMITES.', scale: wordScale3, color: '#ffffff' },
          ].map(({ text, scale, color }) => (
            <div
              key={text}
              style={{
                fontSize: 200,
                fontWeight: 900,
                color,
                lineHeight: 0.9,
                transform: `scale(${scale})`,
                transformOrigin: 'left center',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                letterSpacing: '-0.04em',
              }}
            >
              {text}
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 40,
            opacity: subOpacity,
            fontSize: 22,
            color: '#64748b',
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          OpoClaw — Sistema de agentes autonomos
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 2 — STATS COUNTER (90–210f) ──────────────────────────────────────
const StatCard: React.FC<{
  value: string;
  label: string;
  color: string;
  frame: number;
  delay: number;
  fps: number;
}> = ({ value, label, color, frame, delay, fps }) => {
  const sc = spr(frame, fps, delay, 16);
  const numOpacity = ease(frame, 0, 1, delay, delay + 20);
  return (
    <div
      style={{
        transform: `scale(${sc})`,
        opacity: numOpacity,
        background: '#0d1117',
        border: `1px solid ${color}33`,
        borderRadius: 24,
        padding: '48px 56px',
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '40%',
          background: `linear-gradient(to top, ${color}18, transparent)`,
        }}
      />
      <div
        style={{
          fontSize: 90,
          fontWeight: 900,
          color,
          lineHeight: 1,
          letterSpacing: '-0.03em',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 16,
          color: '#475569',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          marginTop: 16,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
    </div>
  );
};

const SceneStats: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const titleOpacity = ease(frame, 0, 1, 0, 20);
  const bgProgress = ease(frame, 0, 1, 0, 40);

  const stats = [
    { value: '11', label: 'Agentes activos', color: '#0d9488' },
    { value: '24/7', label: 'Operacion continua', color: '#3b82f6' },
    { value: '40', label: 'Trades ejecutados', color: '#8b5cf6' },
    { value: '+77%', label: 'Win rate Nakamoto', color: '#10b981' },
  ];

  return (
    <AbsoluteFill
      style={{
        background: '#060a12',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 100px',
        gap: 60,
      }}
    >
      <GlitchLines frame={frame + 7} />
      <StripeAccent progress={bgProgress} color="#3b82f6" />

      <div style={{ opacity: titleOpacity, position: 'relative', zIndex: 2 }}>
        <div
          style={{
            fontSize: 15,
            color: '#0d9488',
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
            marginBottom: 12,
            fontWeight: 700,
          }}
        >
          Por los numeros
        </div>
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: '#f1f5f9',
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
          }}
        >
          El sistema
          <br />
          <span style={{ color: '#0d9488' }}>nunca para.</span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 24,
          position: 'relative',
          zIndex: 2,
        }}
      >
        {stats.map((s, i) => (
          <StatCard key={s.label} {...s} frame={frame} delay={i * 10} fps={fps} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ── Scene 3 — CINEMATIC BRAND CLOSE (210–360f) ────────────────────────────
const SceneClose: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const lineProgress = ease(frame, 0, 1, 0, 35);
  const logoScale = spr(frame, fps, 30, 18);
  const tagOpacity = ease(frame, 0, 1, 55, 85);
  const ctaOpacity = ease(frame, 0, 1, 75, 100);
  const ctaY = ease(frame, 20, 0, 75, 100);

  const pulse = Math.sin((frame / 8) * Math.PI) * 0.04 + 1;

  return (
    <AbsoluteFill
      style={{
        background: '#030608',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
      }}
    >
      <GlitchLines frame={frame + 13} />

      {/* Radial glow */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 800,
          height: 800,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, #0d948822 0%, #3b82f611 40%, transparent 70%)',
          transform: `translate(-50%, -50%) scale(${pulse})`,
        }}
      />

      {/* Horizontal line reveal */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: `${(1 - lineProgress) * 50}%`,
          right: `${(1 - lineProgress) * 50}%`,
          height: 1,
          background: 'linear-gradient(90deg, transparent, #0d9488, #3b82f6, transparent)',
          opacity: lineProgress,
        }}
      />

      {/* Logo / wordmark */}
      <div
        style={{
          transform: `scale(${logoScale})`,
          textAlign: 'center',
          zIndex: 2,
        }}
      >
        <div
          style={{
            fontSize: 140,
            fontWeight: 900,
            letterSpacing: '-0.05em',
            lineHeight: 1,
            fontFamily: 'system-ui, sans-serif',
            background: 'linear-gradient(135deg, #ffffff 0%, #94a3b8 60%, #0d9488 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          OpoClaw
        </div>
      </div>

      <div
        style={{
          opacity: tagOpacity,
          marginTop: 32,
          fontSize: 18,
          color: '#334155',
          letterSpacing: '0.4em',
          textTransform: 'uppercase',
          fontWeight: 600,
          zIndex: 2,
        }}
      >
        Tu empresa. Autonoma.
      </div>

      <div
        style={{
          opacity: ctaOpacity,
          transform: `translateY(${ctaY}px)`,
          marginTop: 64,
          background: 'linear-gradient(135deg, #0d9488, #3b82f6)',
          borderRadius: 99,
          padding: '18px 56px',
          fontSize: 18,
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: '0.05em',
          zIndex: 2,
        }}
      >
        opoclaw.com
      </div>
    </AbsoluteFill>
  );
};

// ── ROOT COMPOSITION ────────────────────────────────────────────────────────
export const CinematicAd: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: '#060a12' }}>
      <Sequence from={0} durationInFrames={100}>
        <SceneOpener frame={frame} fps={fps} />
      </Sequence>
      <Sequence from={90} durationInFrames={130}>
        <SceneStats frame={frame - 90} fps={fps} />
      </Sequence>
      <Sequence from={210}>
        <SceneClose frame={frame - 210} fps={fps} />
      </Sequence>
    </AbsoluteFill>
  );
};
