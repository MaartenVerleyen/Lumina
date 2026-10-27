import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirmDialog } from "../../confirm";
import { PhotoItem, OllamaStatus, AiAnalysisResult, AiPerf, OllamaPullProgress, AiFailureItem, AiBatchReport } from "../../types/lumina";
import { diskPathOf } from "../../utils/rawPairs";
import { AI_CANCELLED, PULL_CANCELLED, summarizeAiPerf, topLibraryTags } from "./shared";
import type { LibraryCore } from "./core";

// AI captions, tags and text through Ollama: status, model download, single and batch analysis
export function useAi(core: LibraryCore) {
  const { photosRef, activePhoto, setPhotos, addLog, setError, setAutoMatchNotice } = core;
  const [ollamaPullProgress, setOllamaPullProgress] = useState<OllamaPullProgress | null>(null);
  // Batch AI Report Modal State
  const [aiBatchReport, setAiBatchReport] = useState<AiBatchReport | null>(null);
  // Ollama & Progress States
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [aiModel, setAiModel] = useState<string>("qwen3-vl:8b");
  const [analyzingHashes, setAnalyzingHashes] = useState<Set<string>>(new Set());
  const [isLoadingVram, setIsLoadingVram] = useState<boolean>(false);
  const [aiBatchProgress, setAiBatchProgress] = useState<{
    current: number;
    total: number;
    succeeded: number;
    failed: number;
    currentFile?: string;
    startedAt: number;
    stopping?: boolean;
  } | null>(null);
  const cancelBatchRef = useRef<boolean>(false);

  // Listen for Ollama Pull Progress Events
  useEffect(() => {
    const unlisten = listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setOllamaPullProgress(null);
        setAutoMatchNotice(`Smart Photo Assistant (${prog.model}) installed and ready!`);
        addLog("AI", `Downloaded & installed Ollama model: ${prog.model}`);
      } else {
        setOllamaPullProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog]);

  // Poll Ollama status every 10s & only trigger React state update if status actually changed!
  useEffect(() => {
    let mounted = true;
    async function checkStatus() {
      try {
        const s = await invoke<OllamaStatus>("check_ollama_status");
        if (!mounted) return;
        setOllamaStatus((prev) => {
          if (
            prev &&
            prev.running === s.running &&
            prev.active_vram_model === s.active_vram_model &&
            prev.installed_models.length === s.installed_models.length
          ) {
            return prev;
          }
          return s;
        });
        if (
          s.installed_models.length > 0 &&
          !s.installed_models.some((m) => m.name === aiModel)
        ) {
          setAiModel(s.installed_models[0].name);
        }
      } catch {
        if (!mounted) return;
        setOllamaStatus((prev) =>
          prev && !prev.running
            ? prev
            : { running: false, active_vram_model: null, installed_models: [] }
        );
      }
    }
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [aiModel]);

  async function handlePullDefaultAiModel(modelToPull = "qwen3-vl:8b") {
    if (ollamaPullProgress) return;
    try {
      addLog("AI", `Started downloading Ollama model: ${modelToPull}`);
      await invoke<string>("pull_ollama_model", { modelName: modelToPull });
      const s = await invoke<OllamaStatus>("check_ollama_status");
      setOllamaStatus(s);
      setAiModel(modelToPull);
    } catch (err) {
      setOllamaPullProgress(null);
      if (String(err).includes(PULL_CANCELLED)) {
        setAutoMatchNotice("Model download cancelled. Starting it again resumes where it stopped.");
        addLog("AI", `Cancelled downloading Ollama model: ${modelToPull}`);
      } else {
        setError(String(err));
      }
    }
  }

  // Cancel button of the progress dialog: stops a model download or the folder scan, whichever is running
  async function handleCancelOperation() {
    try {
      await invoke(ollamaPullProgress ? "cancel_ollama_pull" : "cancel_folder_scan");
    } catch (err) {
      setError(String(err));
    }
  }

  function applyAiResults(results: Map<string, AiAnalysisResult>) {
    if (results.size === 0) return;
    setPhotos((prev) =>
      prev.map((p) => {
        const res = results.get(p.hash);
        return res
          ? {
              ...p,
              tags: res.tags,
              people: res.people,
              faces: res.faces,
              ai_caption: res.caption,
              ocr_text: res.ocr_text,
            }
          : p;
      })
    );
  }

  async function handleAiAnalyzeSingle() {
    if (!activePhoto || analyzingHashes.has(activePhoto.hash)) return;
    if (aiBatchProgress) {
      // Ollama handles one request at a time: a single analysis would just queue behind the batch
      setError("Batch AI is running: wait for it to finish or stop it first.");
      return;
    }
    if (ollamaStatus && !ollamaStatus.running) {
      setError('Ollama is not running: click "Start Ollama" in the header first.');
      return;
    }
    const photo = activePhoto;
    try {
      setAnalyzingHashes((prev) => new Set(prev).add(photo.hash));
      const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
        hash: photo.hash,
        imagePathForAi: diskPathOf(photo),
        modelName: aiModel,
        existingTags: topLibraryTags(photosRef.current),
      });
      applyAiResults(new Map([[photo.hash, res]]));
      addLog("AI", `AI analyzed ${photo.name}`, `${res.tags.length} tags generated`);
      addLog("PERF", `AI analysis (${aiModel}): ${photo.name}`, summarizeAiPerf([res.perf]));
    } catch (err) {
      if (!String(err).includes(AI_CANCELLED)) {
        setError(`AI Error on ${photo.name}: ${String(err)}`);
      }
    } finally {
      setAnalyzingHashes((prev) => {
        const next = new Set(prev);
        next.delete(photo.hash);
        return next;
      });
    }
  }

  // Stop: also aborts the request Ollama is working on right now (it stops generating)
  async function handleStopAiBatch() {
    cancelBatchRef.current = true;
    setAiBatchProgress((p) => (p ? { ...p, stopping: true } : p));
    try {
      await invoke("cancel_ai_analysis");
    } catch {}
  }

  // Batch AI runner: one request at a time (qwen3-vl can't run requests in parallel in Ollama), with the next
  // photo's image prepared while the current one is analysed, retries for real failures, and batched UI updates.
  // Photos that already have AI results are skipped unless the user chooses to re-analyse them.
  async function runBatchAiOnList(requested: PhotoItem[], options: { reanalyze?: boolean } = {}) {
    if (aiBatchProgress || requested.length === 0) return;
    if (ollamaStatus && !ollamaStatus.running) {
      setError('Ollama is not running: click "Start Ollama" in the header first.');
      return;
    }

    let targets = requested;
    if (!options.reanalyze) {
      const analyzed = requested.filter((p) => p.ai_caption);
      if (analyzed.length > 0) {
        const fresh = requested.length - analyzed.length;
        const redo = await confirmDialog(
          fresh > 0
            ? `${analyzed.length} of these ${requested.length} photos already have AI results. Analyse those again as well? Their caption, text and tags will be replaced.\n\nChoose "Only new photos" to analyse just the ${fresh} photo(s) without results.`
            : `All ${requested.length} photo(s) already have AI results. Analyse them again? Their caption, text and tags will be replaced.`,
          {
            title: "Batch AI",
            kind: "info",
            okLabel: "Analyse again",
            cancelLabel: fresh > 0 ? "Only new photos" : "Cancel",
          }
        );
        if (!redo) targets = requested.filter((p) => !p.ai_caption);
      }
    }
    if (targets.length === 0) return;

    cancelBatchRef.current = false;
    setAiBatchReport(null);
    setAiBatchProgress({
      current: 0,
      total: targets.length,
      succeeded: 0,
      failed: 0,
      currentFile: targets[0]?.name,
      startedAt: Date.now(),
    });

    addLog("AI", `Started Batch AI on ${targets.length} photo(s) using ${aiModel}`);

    const batchStartedAt = performance.now();
    const batchPerfs: AiPerf[] = [];
    let completedCount = 0;
    let succeededCount = 0;
    let stopped = false;
    const failures: AiFailureItem[] = [];
    const MAX_ATTEMPTS = 3;

    // Results reach the grid in batches (every ~0.5 s) instead of one full re-render per photo
    const pending = new Map<string, AiAnalysisResult>();
    let lastFlush = performance.now();
    const flush = () => {
      applyAiResults(new Map(pending));
      pending.clear();
      lastFlush = performance.now();
    };

    for (let i = 0; i < targets.length; i++) {
      if (cancelBatchRef.current) break;
      const photo = targets[i];

      // Prepare the next photo's 896px image while Ollama works on this one
      const next = targets[i + 1];
      if (next) {
        invoke("prepare_ai_image", { hash: next.hash, imagePath: diskPathOf(next) }).catch(() => {});
      }

      setAnalyzingHashes((prev) => new Set(prev).add(photo.hash));
      setAiBatchProgress((p) => (p ? { ...p, currentFile: photo.name } : p));

      let attempt = 0;
      let success = false;
      let lastErr = "";

      while (attempt < MAX_ATTEMPTS && !success && !cancelBatchRef.current) {
        attempt++;
        try {
          const res = await invoke<AiAnalysisResult>("ai_analyze_photo", {
            hash: photo.hash,
            imagePathForAi: diskPathOf(photo),
            modelName: aiModel,
            existingTags: topLibraryTags(photosRef.current),
          });
          success = true;
          succeededCount++;
          batchPerfs.push(res.perf);
          pending.set(photo.hash, res);
        } catch (err) {
          lastErr = String(err);
          if (lastErr.includes(AI_CANCELLED)) {
            stopped = true;
            break;
          }
          if (attempt < MAX_ATTEMPTS && !cancelBatchRef.current) {
            await new Promise((r) => setTimeout(r, 450 * attempt));
          }
        }
      }

      setAnalyzingHashes((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(photo.hash);
        return nextSet;
      });
      if (stopped || cancelBatchRef.current) break;

      if (!success) {
        failures.push({
          photo,
          error: lastErr || "Unknown AI error",
          attempts: attempt,
        });
      }

      completedCount++;
      setAiBatchProgress((p) =>
        p ? { ...p, current: completedCount, succeeded: succeededCount, failed: failures.length } : p
      );
      if (performance.now() - lastFlush >= 500) flush();
    }

    flush();
    setAnalyzingHashes(new Set());
    setAiBatchProgress(null);

    const wasStopped = stopped || cancelBatchRef.current;
    addLog(
      "AI",
      wasStopped
        ? `Stopped Batch AI after ${completedCount} of ${targets.length} photo(s): ${succeededCount} succeeded, ${failures.length} failed`
        : `Finished Batch AI: ${succeededCount} succeeded, ${failures.length} failed`
    );

    if (batchPerfs.length > 0) {
      const wallSeconds = (performance.now() - batchStartedAt) / 1000;
      const perMinute = (succeededCount / (wallSeconds / 60)).toFixed(1);
      addLog(
        "PERF",
        `Batch AI (${aiModel}): ${succeededCount} photos in ${wallSeconds.toFixed(1)} s · ${perMinute} photos/min`,
        summarizeAiPerf(batchPerfs)
      );
    }

    if (targets.length > 1 || failures.length > 0) {
      setAiBatchReport({
        succeededCount,
        failures,
      });
    }
  }

  return {
    ollamaStatus,
    setOllamaStatus,
    aiModel,
    setAiModel,
    ollamaPullProgress,
    handlePullDefaultAiModel,
    handleCancelOperation,
    analyzingHashes,
    isLoadingVram,
    setIsLoadingVram,
    aiBatchProgress,
    cancelBatchRef,
    aiBatchReport,
    setAiBatchReport,
    handleAiAnalyzeSingle,
    runBatchAiOnList,
    handleStopAiBatch,
  };
}
