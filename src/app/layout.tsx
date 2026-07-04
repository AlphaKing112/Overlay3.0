import "../styles/globals.css";
import { ReactNode } from "react";
import { Montserrat, Inter, Teko, Bangers, Courier_Prime, Comic_Neue } from "next/font/google";
import { performStartupValidation } from '@/lib/startup';
import { Analytics } from '@vercel/analytics/react';

// Font configuration
const montserrat = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600", "800"], display: "swap", variable: "--font-montserrat" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "600", "800"], display: "swap", variable: "--font-inter" });
const teko = Teko({ subsets: ["latin"], weight: ["400", "600"], display: "swap", variable: "--font-teko" });
const bangers = Bangers({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-bangers" });
const courier = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], display: "swap", variable: "--font-courier" });
const comic = Comic_Neue({ subsets: ["latin"], weight: ["400", "700"], display: "swap", variable: "--font-comic" });

export const metadata = {
  title: "IRL Stream Overlay",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Perform startup validation (only in development)
  if (process.env.NODE_ENV === 'development') {
    performStartupValidation();
  }
  
  return (
    <html lang="en" className={`${montserrat.className} ${montserrat.variable} ${inter.variable} ${teko.variable} ${bangers.variable} ${courier.variable} ${comic.variable}`}>
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="preconnect" href="https://flagcdn.com" />
        <link rel="preconnect" href="https://api.open-meteo.com" />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
} 