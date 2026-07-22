import "../styles/globals.css";
import { ReactNode } from "react";
import { Montserrat, Inter, Teko, Bangers, Courier_Prime, Comic_Neue, Anton, Bebas_Neue, Oswald, Russo_One, Righteous, Permanent_Marker } from "next/font/google";
import { performStartupValidation } from '@/lib/startup';
import { Analytics } from '@vercel/analytics/react';

// Font configuration
const montserrat = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600", "800"], display: "swap", variable: "--font-montserrat" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "600", "800"], display: "swap", variable: "--font-inter" });
const teko = Teko({ subsets: ["latin"], weight: ["400", "600"], display: "swap", variable: "--font-teko" });
const bangers = Bangers({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-bangers" });
const courier = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], display: "swap", variable: "--font-courier" });
const comic = Comic_Neue({ subsets: ["latin"], weight: ["400", "700"], display: "swap", variable: "--font-comic" });
const anton = Anton({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-anton" });
const bebas = Bebas_Neue({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-bebas" });
const oswald = Oswald({ subsets: ["latin"], weight: ["400", "700"], display: "swap", variable: "--font-oswald" });
const russo = Russo_One({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-russo" });
const righteous = Righteous({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-righteous" });
const marker = Permanent_Marker({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-marker" });

export const metadata = {
  title: "IRL Stream Overlay",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Perform startup validation (only in development)
  if (process.env.NODE_ENV === 'development') {
    performStartupValidation();
  }
  
  return (
    <html lang="en" className={`${montserrat.className} ${montserrat.variable} ${inter.variable} ${teko.variable} ${bangers.variable} ${courier.variable} ${comic.variable} ${anton.variable} ${bebas.variable} ${oswald.variable} ${russo.variable} ${righteous.variable} ${marker.variable}`}>
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