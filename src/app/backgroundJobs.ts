import type { BackgroundJob } from "../components/layout/BottomStatusBar";
import type { LibraryState } from "../hooks/useLibraryState";

// Batch AI speed and remaining time, from the photos finished so far
export function aiBatchRateOf(prog: LibraryState["aiBatchProgress"]) {
  if (!prog || prog.current < 2) return null;
  const minutes = (Date.now() - prog.startedAt) / 60000;
  if (minutes <= 0) return null;
  const perMinute = prog.current / minutes;
  const remainingMin = (prog.total - prog.current) / perMinute;
  const etaLabel =
    remainingMin < 1 ? `${Math.max(1, Math.round(remainingMin * 60))} s` : `${Math.round(remainingMin)} min`;
  return { perMinute, etaLabel };
}

// Everything running in the background, for the jobs panel in the status bar
export function backgroundJobsOf(lib: LibraryState): BackgroundJob[] {
  const aiBatchRate = aiBatchRateOf(lib.aiBatchProgress);
  const jobs: BackgroundJob[] = [];
  if (lib.ollamaPullProgress) {
    jobs.push({
      id: "model-pull",
      label: `Downloading ${lib.ollamaPullProgress.model}`,
      detail: `${lib.ollamaPullProgress.completed_mb} / ${lib.ollamaPullProgress.total_mb} MB`,
      completed: lib.ollamaPullProgress.percent,
      total: 100,
      onCancel: lib.handleCancelOperation,
    });
  } else if (lib.isScanningFolder || lib.scanProgress) {
    jobs.push({
      id: "folder-scan",
      label: lib.scanProgress?.stage || "Scanning folder",
      detail: lib.scanProgress?.current_file,
      completed: lib.scanProgress?.completed ?? 0,
      total: lib.scanProgress?.total ?? 0,
      onCancel: lib.handleCancelOperation,
    });
  }
  if (lib.progress) {
    jobs.push({
      id: "thumbnails",
      label: "Making thumbnails",
      completed: lib.progress.completed,
      total: lib.progress.total,
      onCancel: lib.handleCancelThumbnails,
      cancelLabel: "Stop",
    });
  }
  if (lib.faceModelDownload) {
    jobs.push({
      id: "face-models",
      label: "Downloading face models (once)",
      detail: `${lib.faceModelDownload.downloaded_mb} / ${lib.faceModelDownload.total_mb} MB`,
      completed: lib.faceModelDownload.percent,
      total: 100,
    });
  } else if (lib.faceScanProgress) {
    jobs.push({
      id: "face-scan",
      label: "Face scan",
      detail: `${lib.faceScanProgress.faces_found} faces found`,
      completed: lib.faceScanProgress.completed,
      total: lib.faceScanProgress.total,
      onCancel: lib.handleCancelFaceScan,
      cancelLabel: "Stop",
    });
  }
  if (lib.faceQualityProgress) {
    jobs.push({
      id: "face-quality",
      label: "Checking eyes and focus",
      completed: lib.faceQualityProgress.completed,
      total: lib.faceQualityProgress.total,
    });
  }
  if (lib.semanticProgress) {
    const downloading = lib.semanticProgress.stage === "download";
    jobs.push({
      id: "semantic",
      label: downloading ? "Downloading smart search models (once)" : "Indexing for smart search",
      detail: downloading ? `${lib.semanticProgress.completed} / ${lib.semanticProgress.total} MB` : undefined,
      completed: lib.semanticProgress.completed,
      total: lib.semanticProgress.total,
      onCancel: lib.handleCancelSemanticIndex,
      cancelLabel: "Stop",
    });
  }
  if (lib.importProgress) {
    const reading = lib.importProgress.stage === "Reading";
    jobs.push({
      id: "import",
      label: reading ? "Reading the card" : "Importing photos",
      detail: reading ? `${lib.importProgress.completed} files` : lib.importProgress.current,
      completed: lib.importProgress.completed,
      total: lib.importProgress.total,
      onCancel: lib.handleCancelImport,
      cancelLabel: "Stop",
    });
  }
  if (lib.exportProgress) {
    jobs.push({
      id: "export",
      label: "Exporting photos",
      completed: lib.exportProgress.completed,
      total: lib.exportProgress.total,
      onCancel: lib.handleCancelExport,
      cancelLabel: "Stop",
    });
  }
  if (lib.aiBatchProgress) {
    jobs.push({
      id: "ai-batch",
      label: "Batch AI",
      detail: aiBatchRate ? `${aiBatchRate.perMinute.toFixed(1)} photos/min` : lib.aiBatchProgress.currentFile,
      completed: lib.aiBatchProgress.current,
      total: lib.aiBatchProgress.total,
      onCancel: lib.handleStopAiBatch,
      cancelLabel: "Stop",
      cancelling: lib.aiBatchProgress.stopping,
    });
  }
  return jobs;
}
