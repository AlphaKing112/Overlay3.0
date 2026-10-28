import { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Full Stream Map | IRL Overlay',
  description: 'Full Screen Realtime GPS Stream Map for OBS Browser Source',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function MapLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
