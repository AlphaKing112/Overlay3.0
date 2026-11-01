import { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Low Bitrate & Scene Switcher | Overlay 3.0',
  description: 'Automatic low bitrate switching, OBS scene controls, stream health telemetry & chat commands inside your overlay.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function LowBitrateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

