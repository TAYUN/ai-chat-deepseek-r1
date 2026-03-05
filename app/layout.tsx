import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EdgeOne Pages AI: Utilize DeepSeek 671B for Free on the Edge.',
  description:
    'EdgeOne Pages AI offers free access to DeepSeek 671B for enhanced edge computing capabilities.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
