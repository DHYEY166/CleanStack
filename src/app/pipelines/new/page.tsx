"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";

const ACCEPTED_TYPES = [
  ".csv", ".tsv", ".txt", ".json", ".jsonl",
  ".xlsx", ".xls", ".pdf", ".jpg", ".jpeg", ".png",
  ".xml", ".parquet",
];

const FORMAT_LABELS: Record<string, string> = {
  csv: "CSV", tsv: "TSV", txt: "Text", json: "JSON", jsonl: "JSONL",
  xlsx: "Excel", xls: "Excel", pdf: "PDF", jpg: "Image", jpeg: "Image",
  png: "Image", xml: "XML", parquet: "Parquet",
};

export default function NewPipelinePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<"form" | "uploading" | "processing">("form");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  function handleFile(f: File) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPTED_TYPES.includes(`.${ext}`)) {
      setError(`Unsupported file type: .${ext}`);
      return;
    }
    setFile(f);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !file) return;
    setError(null);
    setStep("uploading");
    setProgress(10);

    try {
      // 1. Create pipeline
      const pipelineRes = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const { pipeline, error: pErr } = await pipelineRes.json();
      if (pErr) throw new Error(pErr);
      setProgress(25);

      // 2. Get presigned URL
      const uploadRes = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline_id: pipeline.id,
          filename: file.name,
          content_type: file.type || "application/octet-stream",
        }),
      });
      const { presigned_url, run_id, error: uErr } = await uploadRes.json();
      if (uErr) throw new Error(uErr);
      setProgress(40);

      // 3. Upload to S3
      await fetch(presigned_url, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      setProgress(70);
      setStep("processing");

      // 4. Poll for status
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const statusRes = await fetch(`/api/run-status/${run_id}`);
        const { run } = await statusRes.json();

        if (run?.status === "awaiting_approval" || run?.status === "awaiting_ai") {
          clearInterval(poll);
          router.push(`/pipelines/${pipeline.id}/runs/${run_id}`);
        } else if (run?.status === "failed") {
          clearInterval(poll);
          setError(run.error_message ?? "Pipeline run failed");
          setStep("form");
        } else if (attempts > 60) {
          clearInterval(poll);
          router.push(`/pipelines/${pipeline.id}/runs/${run_id}`);
        }

        setProgress(Math.min(95, 70 + attempts));
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStep("form");
    }
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-white mb-2">New Pipeline</h1>
        <p className="text-gray-400 text-sm mb-8">
          Upload your data file and CleanStack will profile it automatically.
        </p>

        {step === "form" && (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Pipeline name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. HubSpot CRM Cleaner"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Description <span className="text-gray-500">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What data does this pipeline clean?"
                rows={2}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm resize-none"
              />
            </div>

            {/* File upload */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Data file <span className="text-red-400">*</span>
              </label>
              <div
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                  dragging
                    ? "border-indigo-500 bg-indigo-500/10"
                    : file
                    ? "border-green-500/50 bg-green-500/5"
                    : "border-gray-700 hover:border-gray-500"
                }`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files[0];
                  if (f) handleFile(f);
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept={ACCEPTED_TYPES.join(",")}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
                {file ? (
                  <div>
                    <div className="text-green-400 font-medium">{file.name}</div>
                    <div className="text-gray-500 text-xs mt-1">
                      {FORMAT_LABELS[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "File"} ·{" "}
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                    <button
                      type="button"
                      className="text-xs text-gray-500 hover:text-gray-300 mt-2"
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="text-gray-300 mb-1">Drop file here or click to browse</div>
                    <div className="text-gray-500 text-xs">
                      CSV, Excel, PDF, JSON, XML, Parquet, Images · Max 50MB
                    </div>
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!name.trim() || !file}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-3 rounded-lg font-medium transition-colors"
            >
              Create Pipeline & Upload
            </button>
          </form>
        )}

        {(step === "uploading" || step === "processing") && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center space-y-4">
            <div className="text-white font-medium">
              {step === "uploading" ? "Uploading your file..." : "Profiling your data..."}
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-gray-400 text-sm">
              {step === "processing"
                ? "Claude is analyzing your data. This takes 10–30 seconds."
                : "Uploading to secure storage..."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
