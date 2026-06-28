"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import PipelineChat from "@/components/PipelineChat";
import {
  Upload,
  Sparkles,
  FileUp,
  FileCheck2,
  X,
  Loader,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";

const ACCEPTED_TYPES = [
  ".csv", ".tsv", ".txt", ".json", ".jsonl",
  ".xlsx", ".xls", ".xml", ".parquet",
  ".pdf", ".docx",
];

const FORMAT_LABELS: Record<string, string> = {
  csv: "CSV", tsv: "TSV", txt: "Text", json: "JSON", jsonl: "JSONL",
  xlsx: "Excel", xls: "Excel", pdf: "PDF", jpg: "Image", jpeg: "Image",
  png: "Image", xml: "XML", parquet: "Parquet",
};

type Tab = "upload" | "chat";
type Step = "form" | "uploading" | "processing";

export default function NewPipelinePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>("upload");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<Step>("form");
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

  function handleChatApply(appliedName: string, appliedDescription: string) {
    setName(appliedName);
    setDescription(appliedDescription);
    setTab("upload");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !file) return;
    setError(null);
    setStep("uploading");
    setProgress(10);

    try {
      const pipelineRes = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const { pipeline, error: pErr } = await pipelineRes.json();
      if (pErr) throw new Error(pErr);
      setProgress(25);

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

      const uploadController = new AbortController();
      const uploadTimeout = setTimeout(() => uploadController.abort(), 120_000);
      try {
        const s3Res = await fetch(presigned_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
          signal: uploadController.signal,
        });
        if (!s3Res.ok) throw new Error(`Upload failed — please retry`);
      } catch (fetchErr) {
        if (fetchErr instanceof DOMException && fetchErr.name === "AbortError") {
          throw new Error("Upload timed out — check your connection and retry");
        }
        throw fetchErr;
      } finally {
        clearTimeout(uploadTimeout);
      }
      setProgress(70);
      setStep("processing");

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
        <h1 className="text-2xl font-bold tracking-tight text-white mb-2">New Pipeline</h1>
        <p className="text-gray-400 text-sm mb-8 leading-relaxed">
          Upload your data file directly, or describe your problem and let AI configure the pipeline.
        </p>

        {/* Tabs */}
        <div className="grid grid-cols-2 gap-1 mb-8 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(["upload", "chat"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex items-center justify-center gap-2 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                tab === t
                  ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20"
                  : "text-gray-400 hover:text-white hover:bg-gray-800/60"
              }`}
            >
              {t === "upload" ? (
                <>
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  Upload File
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Chat Builder
                </>
              )}
            </button>
          ))}
        </div>

        {/* Chat tab */}
        {tab === "chat" && (
          <PipelineChat onApply={handleChatApply} />
        )}

        {/* Upload tab */}
        {tab === "upload" && step === "form" && (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Applied-from-chat banner */}
            {name && (
              <div className="flex items-start gap-2.5 bg-indigo-500/10 border border-indigo-500/30 rounded-lg px-4 py-3 text-indigo-300 text-sm">
                <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>Config applied from Chat Builder — review and upload your file.</span>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Pipeline name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. HubSpot CRM Cleaner"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 transition-colors text-sm"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Description <span className="text-gray-500 font-normal">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What data does this pipeline clean?"
                rows={2}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 transition-colors text-sm resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Data file <span className="text-red-400">*</span>
              </label>
              <div
                className={`group border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                  dragging
                    ? "border-indigo-500 bg-indigo-500/10"
                    : file
                    ? "border-green-500/50 bg-green-500/[0.07]"
                    : "border-gray-700 hover:border-indigo-500/60 hover:bg-gradient-to-b hover:from-indigo-500/[0.07] hover:to-transparent"
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
                  <div className="flex flex-col items-center">
                    <div className="h-11 w-11 rounded-xl bg-green-500/10 flex items-center justify-center mb-3">
                      <FileCheck2 className="h-5 w-5 text-green-400" aria-hidden="true" />
                    </div>
                    <div className="text-green-400 font-medium break-all">{file.name}</div>
                    <div className="text-gray-500 text-xs mt-1">
                      {FORMAT_LABELS[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "File"} ·{" "}
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 mt-3 transition-colors"
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="h-11 w-11 rounded-xl bg-gray-800 flex items-center justify-center mb-3 text-gray-400 group-hover:text-indigo-400 transition-colors">
                      <FileUp className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="text-gray-200 font-medium mb-1">Drop file here or click to browse</div>
                    <div className="text-gray-500 text-xs">Max 50MB</div>
                  </div>
                )}
              </div>
              {/* Supported format chips */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {["CSV", "Excel", "PDF", "JSON", "XML", "Parquet", "Images"].map((fmt) => (
                  <span
                    key={fmt}
                    className="text-[11px] font-medium text-gray-400 bg-gray-900 border border-gray-800 rounded-md px-2 py-0.5"
                  >
                    {fmt}
                  </span>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={!name.trim() || !file}
              className="group w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium transition-colors"
            >
              Create Pipeline & Upload
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-disabled:translate-x-0" aria-hidden="true" />
            </button>
          </form>
        )}

        {(step === "uploading" || step === "processing") && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
            <div className="flex flex-col items-center">
              <div className="h-12 w-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mb-4">
                <Loader className="h-6 w-6 text-indigo-400 animate-spin" aria-hidden="true" />
              </div>
              <div className="text-white font-medium mb-1">
                {step === "uploading" ? "Uploading your file" : "Profiling your data"}
              </div>
              <p className="text-gray-400 text-sm mb-6">
                {step === "processing"
                  ? "Claude is analyzing your data. This takes 10–30 seconds."
                  : "Uploading to secure storage…"}
              </p>
              <div className="w-full max-w-sm">
                <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                  <span>{step === "uploading" ? "Step 1 of 2" : "Step 2 of 2"}</span>
                  <span className="tabular-nums">{progress}%</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
