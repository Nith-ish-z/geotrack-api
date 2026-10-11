import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'GeoTracker API',
  description: 'Backend for the GeoTracker mobile app',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
