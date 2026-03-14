import React from 'react';
import { Composition } from 'remotion';
import { DataVideo } from './compositions/DataVideo';
import { TradingReport } from './compositions/TradingReport';
import { Announcement } from './compositions/Announcement';
import { CinematicAd } from './compositions/CinematicAd';
import { NikeAd } from './compositions/NikeAd';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DataVideo"
        component={DataVideo}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          title: 'OpoClaw Report',
          subtitle: '',
          content: '',
          theme: 'dark'
        }}
      />
      <Composition
        id="DataVideoPortrait"
        component={DataVideo}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          title: 'OpoClaw Report',
          subtitle: '',
          content: '',
          theme: 'dark'
        }}
      />
      <Composition
        id="TradingReport"
        component={TradingReport}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          reportDate: new Date().toLocaleDateString('es-MX'),
          pairs: [],
          pnl: '0',
          trades: 0
        }}
      />
      <Composition
        id="Announcement"
        component={Announcement}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          title: 'Anuncio',
          body: '',
          accent: '#0d9488'
        }}
      />
      <Composition
        id="CinematicAd"
        component={CinematicAd}
        durationInFrames={360}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />
      <Composition
        id="NikeAd"
        component={NikeAd}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />
    </>
  );
};
