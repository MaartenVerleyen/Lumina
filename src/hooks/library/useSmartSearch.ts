import { useState, useEffect, useRef, useCallback } from "react";
import { call, subscribe } from "../../api";
import { confirmDialog } from "../../confirm";
import { PhotoItem, SemanticStatus, SemanticProgress, SemanticHit } from "../../types/lumina";
import { SEMANTIC_CANCELLED } from "./shared";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";

// Smart search (CLIP): indexing, text queries and "find similar"
export function useSmartSearch(core: LibraryCore, filters: FilterState, thumbnailsBusy: boolean) {
  const { folder, folderRef, photos, addLog, setError, setAutoMatchNotice, setViewMode } = core;
  const { setSearchQuery, parsedSearch } = filters;
  const hasPhotos = photos.length > 0;
  // Smart search: the search box describes the photo ("dog on the beach") and CLIP ranks the library.
  // `semanticHits` holds the ranked matches with what they were for (a text query or "similar to" a photo).
  const [smartSearch, setSmartSearch] = useState<boolean>(false);
  const [semanticResult, setSemanticResult] = useState<{
    source: { kind: "text"; query: string } | { kind: "similar"; hash: string; name: string };
    scores: Map<string, number>;
  } | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus | null>(null);
  const [semanticProgress, setSemanticProgress] = useState<SemanticProgress | null>(null);

  const semanticScores =
    semanticResult &&
    (semanticResult.source.kind === "similar" || (smartSearch && parsedSearch.text !== ""))
      ? semanticResult.scores
      : null;

  const refreshSemanticStatus = useCallback(async (currentFolder: string) => {
    if (!currentFolder) return null;
    try {
      const status = await call<SemanticStatus>("semantic_status", { rootFolder: currentFolder });
      setSemanticStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const unlisten = subscribe<SemanticProgress>("semantic-progress", (event) => {
      const prog = event.payload;
      if (prog.done) {
        setSemanticProgress(null);
        refreshSemanticStatus(folderRef.current);
        if (prog.stage === "index" && prog.completed > 0) {
          addLog("AI", `Smart search: indexed ${prog.completed} of ${prog.total} photo(s)${prog.cancelled ? " (stopped)" : ""}`);
        }
      } else {
        setSemanticProgress(prog);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [addLog, refreshSemanticStatus]);

  async function startSemanticIndex(currentFolder = folder) {
    if (!currentFolder) return;
    try {
      await call<number>("start_semantic_index", { rootFolder: currentFolder });
    } catch (err) {
      setSemanticProgress(null);
      if (!String(err).includes(SEMANTIC_CANCELLED)) setError(`Smart search: ${String(err)}`);
    }
  }

  // Once the models are installed, new photos are indexed automatically after their thumbnails are made
  useEffect(() => {
    if (!folder || !hasPhotos || thumbnailsBusy) return;
    const timer = setTimeout(async () => {
      const status = await refreshSemanticStatus(folder);
      if (status?.models_ready && !status.running && status.indexed < status.total) {
        startSemanticIndex(folder);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [folder, hasPhotos, thumbnailsBusy, photos.length]);

  // Turning smart search on the first time downloads the models (asks first)
  async function toggleSmartSearch() {
    if (smartSearch) {
      setSmartSearch(false);
      if (semanticResult?.source.kind === "text") setSemanticResult(null);
      return;
    }
    const status = await refreshSemanticStatus(folder);
    if (status && !status.models_ready) {
      const ok = await confirmDialog(
        "Smart search finds photos by describing them, in Dutch, English and about 50 other languages (\"hond op het strand\", \"birthday cake\").\n\nIt needs a one-time download of about 470 MB of AI models, then indexes this library on your graphics card (about 1 minute per 5,000 photos). Everything stays on this computer.",
        { title: "Smart search", kind: "info", okLabel: "Download and index", cancelLabel: "Not now" }
      );
      if (!ok) return;
      addLog("AI", "Downloading the smart search models");
    }
    setSmartSearch(true);
    if (!status || status.indexed < status.total) startSemanticIndex(folder);
  }

  // Text queries: embedded after a short pause in typing; only the newest query may set the results
  const semanticSeqRef = useRef(0);
  useEffect(() => {
    // The words left once names, dates and places are understood ("at the beach")
    const query = parsedSearch.text;
    if (!smartSearch || !query) return;
    const seq = ++semanticSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        const hits = await call<SemanticHit[]>("semantic_search", { query });
        if (seq !== semanticSeqRef.current) return;
        setSemanticResult({
          source: { kind: "text", query },
          scores: new Map(hits.map((h) => [h.hash, h.score])),
        });
      } catch (err) {
        if (seq === semanticSeqRef.current) setError(`Smart search: ${String(err)}`);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [parsedSearch.text, smartSearch]);

  async function handleFindSimilar(photo: PhotoItem) {
    try {
      const hits = await call<SemanticHit[]>("find_similar_photos", { hash: photo.hash });
      ++semanticSeqRef.current;
      setSemanticResult({
        source: { kind: "similar", hash: photo.hash, name: photo.name },
        scores: new Map(hits.map((h) => [h.hash, h.score])),
      });
      setViewMode("grid");
    } catch (err) {
      setError(String(err));
      if (semanticStatus?.models_ready === false) {
        setAutoMatchNotice('Turn on Smart search (the ✨ button in the search box) to index your photos first.');
      }
    }
  }

  function clearSemanticResult() {
    ++semanticSeqRef.current;
    setSemanticResult(null);
    if (smartSearch) setSearchQuery("");
  }

  async function handleCancelSemanticIndex() {
    try {
      await call("cancel_semantic_index");
    } catch (err) {
      setError(String(err));
    }
  }

  return {
    smartSearch,
    toggleSmartSearch,
    semanticResult,
    setSemanticResult,
    semanticScores,
    semanticStatus,
    semanticProgress,
    startSemanticIndex,
    handleFindSimilar,
    clearSemanticResult,
    handleCancelSemanticIndex,
  };
}

export type SmartSearch = ReturnType<typeof useSmartSearch>;
