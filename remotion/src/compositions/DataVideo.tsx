import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface DataVideoProps {
  title: string;
  subtitle?: string;
  content?: string;
  theme?: 'dark' | 'light';
}

export const DataVideo: React.FC<DataVideoProps> = ({ title, subtitle, content, theme = 'dark' }) => {
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const titleY = interpolate(frame, [0, 20], [40, 0], { extrapolateRight: 'clamp' });

  const subtitleOpacity = interpolate(frame, [15, 35], [0, 1], { extrapolateRight: 'clamp' });
  const contentOpacity = interpolate(frame, [30, 50], [0, 1], { extrapolateRight: 'clamp' });

  const lineWidth = interpolate(frame, [10, 40], [0, 100], { extrapolateRight: 'clamp' });

  const isDark = theme === 'dark';
  const bg = isDark ? '#0a0e1a' : '#ffffff';
  const text = isDark ? '#e2e8f0' : '#0a0e1a';
  const accent = '#0d9488';

  return (
    <AbsoluteFill style={{ background: bg, fontFamily: 'system-ui, -apple-system, sans-serif', padding: 80, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      {/* Accent line */}
      <div style={{ width: `${lineWidth}%`, height: 4, background: accent, marginBottom: 40, borderRadius: 2 }} />

      {/* OpoClaw logo text */}
      <div style={{ fontSize: 18, color: accent, fontWeight: 700, letterSpacing: '0.2em', marginBottom: 30, textTransform: 'uppercase' }}>
        OPOCLAW
      </div>

      {/* Title */}
      <div style={{ fontSize: 72, fontWeight: 800, color: text, lineHeight: 1.1, marginBottom: 24, opacity: titleOpacity, transform: `translateY(${titleY}px)` }}>
        {title}
      </div>

      {/* Subtitle */}
      {subtitle && (
        <div style={{ fontSize: 32, color: isDark ? '#94a3b8' : '#64748b', marginBottom: 40, opacity: subtitleOpacity }}>
          {subtitle}
        </div>
      )}

      {/* Content */}
      {content && (
        <div style={{ fontSize: 24, color: isDark ? '#cbd5e1' : '#334155', lineHeight: 1.6, opacity: contentOpacity, maxWidth: '80%' }}>
          {content}
        </div>
      )}

      {/* Bottom bar */}
      <div style={{ position: 'absolute', bottom: 60, left: 80, right: 80, height: 2, background: isDark ? '#1e3a4a' : '#e2e8f0' }} />
    </AbsoluteFill>
  );
};
