import Nav from "@/components/Nav";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
