import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { TestAuthProvider } from "@/components/TestAuth";
import { isTestMode } from "@/lib/test-mode";
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
  title: "CleanStack — AI Data Pipeline Automation",
  description:
    "Upload raw data, get AI-suggested transforms, approve via Data PR, ship clean data. Serverless B2B data pipeline automation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // TEST MODE ONLY: no Clerk keys in e2e, so no ClerkProvider (see src/lib/test-mode.ts).
  const AuthProvider = isTestMode() ? TestAuthProvider : ClerkProvider;
  return (
    <AuthProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-gray-950 text-gray-100">
          {children}
        </body>
      </html>
    </AuthProvider>
  );
}
