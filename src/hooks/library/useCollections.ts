import { useState, useEffect, useMemo, useCallback } from "react";
import { call, isOwnChange, openLibraryServer, RECONNECTED, subscribe } from "../../api";
import { Album, SavedSearch } from "../../types/lumina";
import { MatchContext } from "../../utils/searchQuery";
import { computeTrips, tripLabel } from "../../utils/trips";
import type { LibraryCore } from "./core";
import type { FilterState } from "./useFilterState";

// Trips found from dates and places, albums and smart albums (saved searches)
export function useCollections(core: LibraryCore, filters: FilterState) {
  const {
    folder,
    photos,
    photoByHash,
    resolveTargets,
    pushCustomUndo,
    confirmAction,
    addLog,
    setError,
    setAutoMatchNotice,
    setActiveBulkPopover,
  } = core;
  const { activeAlbumId, setActiveAlbumId, searchQuery, setSearchQuery } = filters;
  // Albums, smart albums and trip names belong to the engine of the open library: this computer's, or a
  // server's, so they load again when a library of another server (or of this computer) opens
  const server = openLibraryServer();
  // Albums and smart albums (saved searches); `activeAlbumId` filters the grid to one album
  const [albums, setAlbums] = useState<Album[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);

  // Events & trips found from capture time and GPS (newest first); `activeEvent` holds a trip id
  const [tripNames, setTripNames] = useState<Record<string, string>>({});
  useEffect(() => {
    call<Record<string, string>>("get_trip_names").then(setTripNames).catch(() => {});
  }, [folder, server]);
  const trips = useMemo(() => computeTrips(photos), [photos]);
  const tripOfHash = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of trips) for (const h of t.hashes) m.set(h, t.id);
    return m;
  }, [trips]);
  const autoEvents = useMemo(
    () =>
      trips
        .map((t) => ({ id: t.id, label: tripLabel(t, tripNames[t.id]), count: t.hashes.length, kind: t.kind }))
        .reverse(),
    [trips, tripNames]
  );

  async function handleRenameTrip(id: string, name: string) {
    try {
      await call("set_trip_name", { tripId: id, name });
      setTripNames((prev) => {
        const next = { ...prev };
        if (name.trim()) next[id] = name.trim();
        else delete next[id];
        return next;
      });
    } catch (err) {
      setError(String(err));
    }
  }

  const albumSets = useMemo(() => new Map(albums.map((a) => [a.id, new Set(a.hashes)])), [albums]);
  const albumContext = useMemo<MatchContext>(() => {
    const byName = new Map(albums.map((a) => [a.name.toLowerCase(), albumSets.get(a.id)!]));
    return { albumHashes: (name: string) => byName.get(name.toLowerCase()) };
  }, [albums, albumSets]);

  // ---------- Albums & smart albums ----------
  const refreshAlbums = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        call<Album[]>("get_albums"),
        call<SavedSearch[]>("get_saved_searches"),
      ]);
      setAlbums(a);
      setSavedSearches(s);
    } catch {}
  }, []);

  useEffect(() => {
    refreshAlbums();
  }, [refreshAlbums, folder, server]);

  // Another user changed albums, saved searches or trip names on the server
  useEffect(() => {
    const refresh = () => {
      refreshAlbums();
      call<Record<string, string>>("get_trip_names").then(setTripNames).catch(() => {});
    };
    const off = subscribe<{ origin?: string }>("albums-changed", (e) => {
      if (!isOwnChange(e.payload)) refresh();
    });
    // Or did while the event socket was down
    const offReconnected = subscribe(RECONNECTED, refresh);
    return () => {
      off.then((f) => f());
      offReconnected.then((f) => f());
    };
  }, [refreshAlbums]);

  // Photos of each album that are in the open folder
  const albumCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const [id, set] of albumSets) {
      let n = 0;
      for (const h of set) if (photoByHash.has(h)) n++;
      counts.set(id, n);
    }
    return counts;
  }, [albumSets, photoByHash]);

  const patchAlbumHashes = (id: number, add: string[], remove: string[]) => {
    const removeSet = new Set(remove);
    setAlbums((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        const kept = a.hashes.filter((h) => !removeSet.has(h));
        const present = new Set(kept);
        return { ...a, hashes: [...kept, ...add.filter((h) => !present.has(h))] };
      })
    );
  };

  async function handleCreateAlbum(name: string, addHashes?: string[]) {
    try {
      const id = await call<number>("create_album", { name });
      setAlbums((prev) => [...prev, { id, name: name.trim(), hashes: [] }]);
      addLog("LIBRARY", `Created album "${name.trim()}"`);
      if (addHashes && addHashes.length > 0) await handleAddToAlbum(id, addHashes, name.trim());
      return id;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }

  async function handleRenameAlbum(id: number, name: string) {
    try {
      await call("rename_album", { id, name });
      setAlbums((prev) => prev.map((a) => (a.id === id ? { ...a, name: name.trim() } : a)));
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDeleteAlbum(id: number) {
    const album = albums.find((a) => a.id === id);
    if (!album) return;
    const ok = await confirmAction(
      `Delete the album "${album.name}"?\n\nOnly the album goes; its ${album.hashes.length} photo(s) stay where they are.`,
      "Delete album",
      { title: "Delete album", kind: "danger" }
    );
    if (!ok) return;
    try {
      await call("delete_album", { id });
      setAlbums((prev) => prev.filter((a) => a.id !== id));
      if (activeAlbumId === id) setActiveAlbumId(null);
      addLog("LIBRARY", `Deleted album "${album.name}"`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAddToAlbum(id: number, targetHashes?: string[], albumName?: string) {
    const hashes = resolveTargets(targetHashes);
    const name = albumName ?? albums.find((a) => a.id === id)?.name ?? "album";
    if (hashes.length === 0) return;
    try {
      const added = await call<string[]>("add_to_album", { id, hashes });
      patchAlbumHashes(id, added, []);
      if (added.length > 0) {
        pushCustomUndo(
          `Add ${added.length} photo(s) to album "${name}"`,
          hashes,
          async () => {
            await call("remove_from_album", { id, hashes: added });
            patchAlbumHashes(id, [], added);
          },
          async () => {
            await call("add_to_album", { id, hashes: added });
            patchAlbumHashes(id, added, []);
          }
        );
      }
      addLog("LIBRARY", `Added ${added.length} photo(s) to album "${name}"`);
      setActiveBulkPopover(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRemoveFromAlbum(id: number, targetHashes?: string[]) {
    const hashes = resolveTargets(targetHashes);
    const name = albums.find((a) => a.id === id)?.name ?? "album";
    if (hashes.length === 0) return;
    try {
      const removed = await call<string[]>("remove_from_album", { id, hashes });
      patchAlbumHashes(id, [], removed);
      if (removed.length > 0) {
        pushCustomUndo(
          `Remove ${removed.length} photo(s) from album "${name}"`,
          hashes,
          async () => {
            await call("add_to_album", { id, hashes: removed });
            patchAlbumHashes(id, removed, []);
          },
          async () => {
            await call("remove_from_album", { id, hashes: removed });
            patchAlbumHashes(id, [], removed);
          }
        );
      }
      addLog("LIBRARY", `Removed ${removed.length} photo(s) from album "${name}"`);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveSearch(name: string, smart = false) {
    try {
      const id = await call<number>("save_search", { name, query: searchQuery, smart });
      setSavedSearches((prev) => [...prev, { id, name: name.trim(), query: searchQuery.trim(), smart }]);
      setAutoMatchNotice(`Saved smart album "${name.trim()}": it updates by itself as your photos change.`);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }

  async function handleDeleteSavedSearch(id: number) {
    try {
      await call("delete_saved_search", { id });
      setSavedSearches((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(String(err));
    }
  }

  function runSavedSearch(saved: SavedSearch) {
    setActiveAlbumId(null);
    setSearchQuery(saved.query);
  }

  return {
    trips,
    tripOfHash,
    autoEvents,
    handleRenameTrip,
    albums,
    savedSearches,
    albumSets,
    albumContext,
    albumCounts,
    handleCreateAlbum,
    handleRenameAlbum,
    handleDeleteAlbum,
    handleAddToAlbum,
    handleRemoveFromAlbum,
    handleSaveSearch,
    handleDeleteSavedSearch,
    runSavedSearch,
  };
}

export type Collections = ReturnType<typeof useCollections>;
