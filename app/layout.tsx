import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { RobotMark } from "@/components/robot-mark";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fleet Ops",
  description: "Live state of every robot on site, straight from telemetry.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4 sm:px-6">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-md text-ink outline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RobotMark className="h-6 w-6 text-accent" />
              <span className="text-[13px] font-semibold tracking-[0.14em]">
                FLEET OPS
              </span>
            </Link>
            <nav aria-label="Main" className="flex items-center gap-1 text-sm">
              <Link
                href="/"
                className="rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
              >
                Fleet
              </Link>
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>

        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-xs text-muted sm:px-6">
            <span>Fleet telemetry</span>
            <span aria-hidden="true" className="text-line">
              /
            </span>
            <span>robots report roughly once per second</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
