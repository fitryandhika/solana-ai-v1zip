import "./globals.css";

export const metadata = {
  title: "Solana AI — Realtime Token Scanner",
  description:
    "Realtime Solana new-token discovery and experimental market-momentum ranking. Not financial advice."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
