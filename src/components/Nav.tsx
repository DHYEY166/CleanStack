"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { CleanStackLogo } from "@/components/Logo";

const navLinks = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/pipelines/new", label: "New Pipeline" },
  { href: "/templates", label: "Templates" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-gray-800 bg-gray-950 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <Link href="/dashboard" className="text-white">
          <CleanStackLogo iconSize={28} wordmarkClassName="text-lg" />
        </Link>
        <div className="flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                pathname.startsWith(link.href)
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-800/50"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
      <UserButton />
    </nav>
  );
}
