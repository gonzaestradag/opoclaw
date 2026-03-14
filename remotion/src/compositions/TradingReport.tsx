import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

interface TradePair {
  pair: string;
  signal: string;
  pnl?: string;
}

interface TradingReportProps {
  reportDate: string;
  pairs: TradePair[];
  pnl: string;
  trades: number;
}

export const TradingReport: React.FC<TradingReportProps> = ({ reportDate, pairs, pnl, trades }) => {
  const frame = useCurrentFrame();

  const headerOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const statsOpacity = interpolate(frame, [20, 45], [0, 1], { extrapolateRight: 'clamp' });
  const pairsOpacity = interpolate(frame, [40, 65], [0, 1], { extrapolateRight: 'clamp' });

  const isPositive = !String(pnl).startsWith('-');
  const defaultPairs = [{ pair: 'BTC/USDT', signal: 'hold' }, { pair: 'ETH/USDT', signal: 'buy' }, { pair: 'SOL/USDT', signal: 'avoid' }];

  return (
    <AbsoluteFill style={{ background: '#0a0e1a', fontFamily: 'system-ui, sans-serif', padding: 80 }}>
      <div style={{ opacity: headerOpacity, marginBottom: 40 }}>
        <div style={{ fontSize: 16, color: '#0d9488', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 12 }}>OPOCLAW TRADING DESK</div>
        <div style={{ fontSize: 56, fontWeight: 800, color: '#ffffff', marginBottom: 8 }}>Reporte Diario</div>
        <div style={{ fontSize: 24, color: '#64748b' }}>{reportDate}</div>
        <div style={{ width: 80, height: 3, background: '#0d9488', marginTop: 20, borderRadius: 2 }} />
      </div>
      <div style={{ opacity: statsOpacity, display: 'flex', gap: 40, marginBottom: 50 }}>
        {[
          { label: 'P&L del dia', value: String(pnl), color: isPositive ? '#10b981' : '#ef4444' },
          { label: 'Operaciones', value: String(trades), color: '#3b82f6' },
          { label: 'Bots activos', value: '2', color: '#0d9488' },
        ].map((stat, i) => (
          <div key={i} style={{ background: '#111827', borderRadius: 16, padding: '24px 32px', flex: 1, borderLeft: `4px solid ${stat.color}` }}>
            <div style={{ fontSize: 14, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{stat.label}</div>
            <div style={{ fontSize: 40, fontWeight: 800, color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>
      <div style={{ opacity: pairsOpacity }}>
        <div style={{ fontSize: 14, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 16 }}>Señales activas</div>
        {(pairs && pairs.length > 0 ? pairs : defaultPairs).slice(0, 5).map((p, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111827', borderRadius: 10, padding: '16px 24px', marginBottom: 10 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0' }}>{p.pair}</div>
            <div style={{ fontSize: 14, fontWeight: 700, padding: '6px 16px', borderRadius: 99, background: p.signal === 'buy' ? '#064e3b' : p.signal === 'avoid' ? '#7f1d1d' : '#1f2937', color: p.signal === 'buy' ? '#10b981' : p.signal === 'avoid' ? '#ef4444' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{p.signal}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
