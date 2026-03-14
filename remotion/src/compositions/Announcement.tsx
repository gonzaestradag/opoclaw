import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

interface AnnouncementProps {
  title: string;
  body: string;
  accent?: string;
}

export const Announcement: React.FC<AnnouncementProps> = ({ title, body, accent = '#0d9488' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 12 } });
  const bodyOpacity = interpolate(frame, [20, 50], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#0a0e1a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 60, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ transform: `scale(${scale})` }}>
        <div style={{ width: 80, height: 80, borderRadius: '50%', background: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 40, marginLeft: 'auto', marginRight: 'auto' }}>
          <div style={{ fontSize: 36 }}>T</div>
        </div>
        <div style={{ fontSize: 52, fontWeight: 800, color: '#ffffff', textAlign: 'center', marginBottom: 24 }}>{title}</div>
        <div style={{ width: 60, height: 3, background: accent, margin: '0 auto 32px', borderRadius: 2 }} />
      </div>
      <div style={{ fontSize: 28, color: '#94a3b8', textAlign: 'center', lineHeight: 1.6, opacity: bodyOpacity }}>{body}</div>
      <div style={{ position: 'absolute', bottom: 50, fontSize: 14, color: '#374151', letterSpacing: '0.2em', textTransform: 'uppercase' }}>OPOCLAW</div>
    </AbsoluteFill>
  );
};
