import Image from "next/image";
import Link from "next/link";

export default function ArchPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
      <div className="max-w-5xl w-full">
        <div className="flex items-center justify-between mb-6">
          <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">
            ← Back
          </Link>
          <a
            href="/arch.svg"
            download="cleanstack-architecture.svg"
            className="text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-lg transition-colors"
          >
            Download SVG
          </a>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <Image
            src="/arch.svg"
            alt="CleanStack System Architecture"
            width={960}
            height={560}
            className="w-full"
            priority
          />
        </div>
      </div>
    </div>
  );
}
