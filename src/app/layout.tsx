import type { Metadata } from "next";

import "./globals.css";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "Fact Knowledge Layer",
  description:
    "Extracts facts from PDFs, ties each to its evidence, and reports where they agree, conflict, or reconcile.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
