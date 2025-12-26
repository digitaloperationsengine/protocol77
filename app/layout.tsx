import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Protocol 77',
  description: 'Protocol 77 - Table',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
